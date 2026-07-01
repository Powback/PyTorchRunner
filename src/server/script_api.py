"""
Script Execution API for PyTorchRunner  — v3.2.0
Persistent job history, namespace support, safe multi-agent cancellation,
comprehensive storage: PostgreSQL experiments, Redis metrics, artifact files,
and real-time metrics pipeline: stdout detection → DB → SSE metrics events.
"""
import asyncio
import json
import logging
import os
import re
import sys
import uuid
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional

import torch
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .job_store import JobStore
from ..storage.database import Database
from ..storage.experiment_store import ExperimentStore
from ..storage.metrics_store import MetricsStore
from ..storage.artifact_store import ArtifactStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Metrics detection — parse training metrics from stdout lines
# ---------------------------------------------------------------------------

# Require at least one known metric keyword before attempting kv extraction
_METRIC_KW_RE = re.compile(
    r'\b(loss|acc(?:uracy)?|reward|lr|learning[_\s]rate|val[_\s]?loss|val[_\s]?acc|'
    r'train[_\s]?loss|train[_\s]?acc|perplexity|ppl|f1|precision|recall|mae|mse|rmse|'
    r'score|bleu|rouge|kl|entropy|grad[_\s]?norm|throughput)\b',
    re.IGNORECASE,
)
# key=value or key: value with a numeric float (including scientific notation)
_KV_RE = re.compile(
    r'\b([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:]\s*(-?[0-9]+\.?[0-9]*(?:[eE][+\-]?[0-9]+)?)\b'
)


def _detect_metrics_in_line(line: str) -> Optional[Dict[str, float]]:
    """
    Extract named numeric metrics from a single stdout line.

    Returns {name: value} (including step/epoch if present) or None.
    Only triggers on lines that either:
      1. Are a pure JSON object, OR
      2. Contain at least one recognised metric keyword (loss, acc, reward, …)
    This avoids false positives on lines like "Running pid=12345 port=8080".
    """
    line = line.strip()
    if not line:
        return None

    # ── 1. Pure JSON object ───────────────────────────────────────────────
    if line.startswith("{") and line.endswith("}"):
        try:
            data = json.loads(line)
            result = {k: float(v) for k, v in data.items() if isinstance(v, (int, float))}
            if result:
                return result
        except (json.JSONDecodeError, ValueError, TypeError):
            pass

    # ── 2. key=value / key: value line with a metric keyword ─────────────
    if not _METRIC_KW_RE.search(line):
        return None

    pairs = _KV_RE.findall(line)
    if not pairs:
        return None

    result = {}
    for name, val in pairs:
        try:
            result[name] = float(val)
        except ValueError:
            pass

    return result or None


# ---------------------------------------------------------------------------
# In-memory state (active session)
# ---------------------------------------------------------------------------

# Primary job store — all job metadata (source of truth for live jobs)
jobs_db: Dict[str, Dict[str, Any]] = {}
# Subprocess handles for cancellation
processes_db: Dict[str, asyncio.subprocess.Process] = {}

# Max bytes to keep in preview fields (backward compat)
PREVIEW_MAX_BYTES = 2000
# Max bytes to keep in full output buffers (1 MB per stream)
FULL_MAX_BYTES = 1_000_000

# ---------------------------------------------------------------------------
# Job timeout — configurable via env var, defaults to no timeout
# ---------------------------------------------------------------------------
# Set PYTORCHRUNNER_JOB_TIMEOUT=<seconds> to impose a per-job wall-clock
# limit.  Unset (the default) means jobs run until they finish naturally.
# Example: PYTORCHRUNNER_JOB_TIMEOUT=7200  # 2-hour cap
_timeout_env = os.environ.get("PYTORCHRUNNER_JOB_TIMEOUT")
JOB_TIMEOUT: Optional[float] = float(_timeout_env) if _timeout_env else None

# Persistent store (SQLite — lightweight, always available)
job_store = JobStore()

# Advanced storage layer (PostgreSQL + Redis + filesystem)
_db = Database()
_experiment_store = ExperimentStore(_db)
_metrics_store = MetricsStore()
_artifact_store = ArtifactStore(_db)

# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ScriptExecutionRequest(BaseModel):
    script: str
    args: List[str] = []
    cwd: str
    env_vars: Dict[str, str] = {}
    job_name: Optional[str] = None
    namespace: str = "default"
    tags: List[str] = []
    gpu_type: Optional[str] = None  # "mps", "3090", "5090", "any", or None (any)


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="PyTorchRunner Script Executor",
    version="3.0.0",
    description=(
        "MPS-accelerated Python script runner with persistent job history, "
        "namespace isolation, and real-time output streaming."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup():
    await job_store.initialize()
    # Advanced storage (gracefully degrades if unavailable)
    await _db.connect()
    await _metrics_store.connect()
    await _artifact_store.initialize()

    # Reconcile ghost jobs — any job still marked "running" in the persistent
    # DB is a leftover from a previous server session.  The subprocess is gone
    # so they can never be cancelled or monitored; mark them cancelled now so
    # clients don't poll forever.
    now = datetime.utcnow().isoformat()
    stale_jobs = await job_store.list_jobs(status="running")
    if stale_jobs:
        for stale in stale_jobs:
            await job_store.update_job(
                stale["job_id"],
                {
                    "status": "cancelled",
                    "exit_code": -1,
                    "completed_at": now,
                    "updated_at": now,
                    "error": "Server restarted during execution",
                },
            )
        logger.warning(
            "Reconciled %d stale running job(s) as cancelled on startup",
            len(stale_jobs),
        )

    logger.info(
        "PyTorchRunner Script Executor ready (sqlite=%s, postgres=%s, redis=%s)",
        job_store.db_path,
        "connected" if _db.is_connected else "unavailable",
        "connected" if _metrics_store.is_connected else "unavailable",
    )


@app.on_event("shutdown")
async def _shutdown():
    await job_store.close()
    await _db.disconnect()
    await _metrics_store.disconnect()


# ---------------------------------------------------------------------------
# POST /run  — submit a script job
# ---------------------------------------------------------------------------


@app.post("/run", summary="Submit a script for execution")
async def run_script(request: ScriptExecutionRequest, background_tasks: BackgroundTasks):
    """
    Submit a Python script for execution with MPS acceleration.

    - **script**: filename relative to *cwd*
    - **args**: command-line arguments
    - **cwd**: absolute working directory containing the script
    - **env_vars**: extra environment variables
    - **namespace**: logical owner/group (default: ``"default"``)
    """
    job_id = str(uuid.uuid4())

    if not os.path.exists(request.cwd):
        raise HTTPException(
            status_code=400,
            detail=f"Working directory does not exist: {request.cwd}",
        )

    script_path = os.path.join(request.cwd, request.script)
    if not os.path.exists(script_path):
        raise HTTPException(
            status_code=400,
            detail=f"Script not found: {script_path}",
        )

    now = datetime.utcnow().isoformat()
    job_data: Dict[str, Any] = {
        "job_id": job_id,
        "namespace": request.namespace,
        "script": request.script,
        "args": request.args,
        "cwd": request.cwd,
        "env_vars": request.env_vars,
        "job_name": request.job_name or f"script-{job_id[:8]}",
        "tags": request.tags,
        "gpu_type": request.gpu_type,
        "status": "queued",
        "progress": 0.0,
        "created_at": now,
        "updated_at": now,
        # Backward-compatible preview fields (last 2 KB)
        "stdout_preview": "",
        "stderr_preview": "",
        # Full output kept in memory only (up to 1 MB)
        "stdout_full": "",
        "stderr_full": "",
        # Line counts for incremental polling
        "stdout_line_count": 0,
        "stderr_line_count": 0,
        "started_at": None,
        "completed_at": None,
        "exit_code": None,
        "error": None,
    }

    jobs_db[job_id] = job_data

    # Persist to SQLite (always available)
    await job_store.save_job(job_data)
    # Persist to PostgreSQL (gracefully no-ops if unavailable)
    await _experiment_store.create(job_data)

    asyncio.create_task(execute_script(job_id))

    logger.info("Queued job %s [ns=%s]: %s", job_id, request.namespace, request.script)
    return {"job_id": job_id, "status": "queued", "namespace": request.namespace}


# ---------------------------------------------------------------------------
# GET /jobs  — list jobs with filtering
# ---------------------------------------------------------------------------


@app.get("/jobs", summary="List jobs with optional filtering")
async def list_jobs(
    status: Optional[str] = Query(
        None,
        description="Filter by status: queued | running | completed | failed | cancelled",
    ),
    namespace: Optional[str] = Query(None, description="Filter by namespace"),
    limit: int = Query(100, ge=1, le=1000, description="Max results (1-1000)"),
):
    """
    Return a list of jobs from persistent storage.

    Useful for agents to inspect their own job history:

    ```
    GET /jobs?namespace=specllm&status=running
    GET /jobs?namespace=specllm&limit=50
    GET /jobs?status=running
    ```

    Jobs from the current in-memory session are merged with persisted history
    so the response always reflects the latest live state.
    """
    # Pull historical records from SQLite
    db_jobs = await job_store.list_jobs(status=status, namespace=namespace, limit=limit)

    # Overlay live in-memory state (more up-to-date for active jobs)
    seen: Dict[str, Dict[str, Any]] = {}
    for j in db_jobs:
        seen[j["job_id"]] = j

    # Merge live jobs that match the filters
    for job_id, job in jobs_db.items():
        if status and job["status"] != status:
            continue
        if namespace and job.get("namespace") != namespace:
            continue
        # Prefer live data; strip large in-memory-only fields for the list view
        live = {k: v for k, v in job.items() if not k.startswith("_")}
        live.pop("stdout_full", None)
        live.pop("stderr_full", None)
        seen[job_id] = live

    # Sort newest-first, truncate to limit
    results = sorted(seen.values(), key=lambda j: j.get("created_at", ""), reverse=True)
    return {"jobs": results[:limit], "total": len(results)}


# ---------------------------------------------------------------------------
# GET /jobs/{job_id}  — single job status
# ---------------------------------------------------------------------------


@app.get("/jobs/{job_id}", summary="Get status of a single job")
async def get_job_status(job_id: str):
    """
    Return full status for a job, including output previews.

    Checks live in-memory state first; falls back to persistent store for
    historical jobs from previous sessions.
    """
    # Live job (current session)
    if job_id in jobs_db:
        job = dict(jobs_db[job_id])
        # Strip internal SSE line buffers
        job.pop("_stdout_lines", None)
        job.pop("_stderr_lines", None)
        return job

    # Historical job (persisted from a previous session)
    db_job = await job_store.get_job(job_id)
    if db_job:
        return db_job

    raise HTTPException(status_code=404, detail="Job not found")


# ---------------------------------------------------------------------------
# GET /jobs/{job_id}/stream  — SSE live output
# ---------------------------------------------------------------------------


@app.get("/jobs/{job_id}/stream", summary="Stream live output via Server-Sent Events")
async def stream_job_output(job_id: str, since_line: int = 0):
    """
    Server-Sent Events endpoint for real-time job output streaming.

    Connect with: ``curl -N http://localhost:9100/jobs/{job_id}/stream``

    Each event is JSON-encoded:

    - ``{"type": "stdout", "line": "...", "line_no": N}``
    - ``{"type": "stderr", "line": "...", "line_no": N}``
    - ``{"type": "status", "status": "running", "job_id": "..."}``
    - ``{"type": "done", "status": "completed", "exit_code": 0}``
    """
    if job_id not in jobs_db:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator() -> AsyncGenerator[str, None]:
        job = jobs_db[job_id]
        sent_stdout = since_line
        sent_stderr = 0
        sent_metrics = 0  # cursor into job["_metrics_events"]

        yield _sse_event({"type": "status", "status": job["status"], "job_id": job_id})

        while True:
            job = jobs_db.get(job_id)
            if job is None:
                break

            stdout_lines = job.get("_stdout_lines", [])
            while sent_stdout < len(stdout_lines):
                yield _sse_event(
                    {"type": "stdout", "line": stdout_lines[sent_stdout], "line_no": sent_stdout}
                )
                sent_stdout += 1

            stderr_lines = job.get("_stderr_lines", [])
            while sent_stderr < len(stderr_lines):
                yield _sse_event(
                    {"type": "stderr", "line": stderr_lines[sent_stderr], "line_no": sent_stderr}
                )
                sent_stderr += 1

            # Emit structured metrics events (from stdout detection + file watcher)
            metrics_events = job.get("_metrics_events", [])
            while sent_metrics < len(metrics_events):
                yield _sse_event(metrics_events[sent_metrics])
                sent_metrics += 1

            if job.get("status") in ("completed", "failed", "cancelled"):
                # Flush any remaining metrics before the done event
                metrics_events = job.get("_metrics_events", [])
                while sent_metrics < len(metrics_events):
                    yield _sse_event(metrics_events[sent_metrics])
                    sent_metrics += 1
                yield _sse_event(
                    {
                        "type": "done",
                        "status": job["status"],
                        "exit_code": job.get("exit_code"),
                        "stdout_lines": len(stdout_lines),
                        "stderr_lines": len(stderr_lines),
                        "metrics_count": sent_metrics,
                    }
                )
                break

            await asyncio.sleep(0.1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# POST /jobs/{job_id}/cancel  — cancel a single job
# ---------------------------------------------------------------------------


@app.post("/jobs/{job_id}/cancel", summary="Cancel a specific job")
async def cancel_job(job_id: str):
    """Cancel a running job by ID."""
    if job_id not in jobs_db:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs_db[job_id]
    if job["status"] != "running":
        return {"job_id": job_id, "status": job["status"], "message": "Job not running"}

    _kill_process(job_id)

    now = datetime.utcnow().isoformat()
    job.update(
        status="cancelled",
        exit_code=-9,
        completed_at=now,
        updated_at=now,
        error="Cancelled by user",
    )
    await job_store.update_job(
        job_id,
        {
            "status": "cancelled",
            "exit_code": -9,
            "completed_at": now,
            "updated_at": now,
            "error": "Cancelled by user",
        },
    )
    logger.info("Job %s cancelled", job_id)
    return {"job_id": job_id, "status": "cancelled"}


# ---------------------------------------------------------------------------
# DELETE /jobs/cancel  — namespace-scoped bulk cancellation
# ---------------------------------------------------------------------------


@app.delete("/jobs/cancel", summary="Cancel all running jobs in a namespace")
async def cancel_namespace_jobs(
    namespace: str = Query(..., description="Namespace whose running jobs should be cancelled"),
):
    """
    Cancel all *running* jobs that belong to *namespace*.

    This is the safe multi-agent cancellation endpoint — it only affects jobs
    owned by the calling namespace and never touches jobs from other agents.

    ```
    DELETE /jobs/cancel?namespace=specllm
    ```
    """
    cancelled = []
    now = datetime.utcnow().isoformat()

    for job_id, job in jobs_db.items():
        if job.get("namespace") != namespace:
            continue
        if job["status"] != "running":
            continue

        _kill_process(job_id)
        job.update(
            status="cancelled",
            exit_code=-9,
            completed_at=now,
            updated_at=now,
            error=f"Cancelled by namespace owner ({namespace})",
        )
        await job_store.update_job(
            job_id,
            {
                "status": "cancelled",
                "exit_code": -9,
                "completed_at": now,
                "updated_at": now,
                "error": f"Cancelled by namespace owner ({namespace})",
            },
        )
        cancelled.append(job_id)

    logger.info("Namespace '%s' cancel: %d jobs cancelled", namespace, len(cancelled))
    return {"namespace": namespace, "cancelled": len(cancelled), "job_ids": cancelled}


# ---------------------------------------------------------------------------
# POST /jobs/cancel_all  — legacy bulk cancellation (kept for backwards compat)
# ---------------------------------------------------------------------------


@app.post("/jobs/cancel_all", summary="Cancel ALL running jobs (use namespace cancel instead)")
async def cancel_all_jobs():
    """
    Cancel every running job regardless of namespace.

    **Deprecated** — prefer ``DELETE /jobs/cancel?namespace=<ns>`` for safe
    multi-agent operation.  This endpoint is retained for backwards compatibility.
    """
    cancelled = []
    now = datetime.utcnow().isoformat()

    for job_id, job in jobs_db.items():
        if job["status"] != "running":
            continue
        _kill_process(job_id)
        job.update(
            status="cancelled",
            exit_code=-9,
            completed_at=now,
            updated_at=now,
            error="Cancelled by cancel_all",
        )
        await job_store.update_job(
            job_id,
            {
                "status": "cancelled",
                "exit_code": -9,
                "completed_at": now,
                "updated_at": now,
                "error": "Cancelled by cancel_all",
            },
        )
        cancelled.append(job_id)

    logger.info("cancel_all: %d jobs cancelled", len(cancelled))
    return {"cancelled": len(cancelled), "job_ids": cancelled}


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


@app.get("/health", summary="Service health check")
async def health_check():
    mps_available = torch.backends.mps.is_available()
    queued = sum(1 for j in jobs_db.values() if j["status"] == "queued")
    running = sum(1 for j in jobs_db.values() if j["status"] == "running")
    return {
        "service": "PyTorchRunner Script Executor",
        "status": "healthy",
        "mps_available": mps_available,
        "queue_size": queued,
        "active_jobs": running,
        "api_version": "3.0.0",
        "persistent_store": job_store.db_path,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _kill_process(job_id: str):
    proc = processes_db.pop(job_id, None)
    if proc and proc.returncode is None:
        try:
            proc.kill()
        except Exception:
            pass


async def _store_metrics(job_id: str, metrics: Dict[str, float], step: Optional[int]) -> None:
    """
    Persist detected metrics to PostgreSQL and Redis (fire-and-forget).
    Also updates the in-memory metrics_summary for the job so the /jobs
    list endpoint reflects the latest values without a DB round-trip.
    """
    try:
        await _experiment_store.record_metrics_batch(job_id, metrics, step=step)
        await _metrics_store.record_metrics_dict(job_id, metrics, step=step)
        await _experiment_store.update_metrics_summary(job_id, metrics)
        # Mirror into in-memory job so /jobs endpoint shows live metrics
        if job_id in jobs_db:
            jobs_db[job_id].setdefault("metrics_summary", {}).update(metrics)
    except Exception as exc:
        logger.debug("_store_metrics error for job %s: %s", job_id, exc)


async def _read_metrics_file_chunk(
    job_id: str,
    metrics_path: str,
    job_data: dict,
    offset: int,
) -> int:
    """
    Read any new JSONL lines from *metrics_path* starting at *offset*.
    Returns the new file offset.

    Each line must be a JSON object.  Keys ``step``, ``epoch``,
    ``timestamp`` are used as coordinates, not stored as metric values.
    """
    if not os.path.exists(metrics_path):
        return offset
    try:
        with open(metrics_path, "r", errors="replace") as fh:
            fh.seek(offset)
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    data = json.loads(raw)
                    step = data.pop("step", None)
                    epoch = data.pop("epoch", None)
                    data.pop("timestamp", None)
                    metrics = {k: float(v) for k, v in data.items() if isinstance(v, (int, float))}
                    if metrics:
                        s = int(step) if step is not None else None
                        asyncio.create_task(_store_metrics(job_id, metrics, s))
                        evt: Dict[str, Any] = {"type": "metrics", "metrics": metrics}
                        if s is not None:
                            evt["step"] = s
                        if epoch is not None:
                            evt["epoch"] = int(epoch)
                        job_data.setdefault("_metrics_events", []).append(evt)
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
            return fh.tell()
    except OSError as exc:
        logger.debug("Metrics file read error for job %s: %s", job_id, exc)
        return offset


async def _watch_metrics_file(job_id: str, metrics_path: str, job_data: dict) -> None:
    """
    Tail *metrics_path* while a job is running, emitting metrics events
    for every new JSONL line.  Exits cleanly when the job finishes and
    does one final read to capture any last-second writes.
    """
    offset = 0
    while True:
        offset = await _read_metrics_file_chunk(job_id, metrics_path, job_data, offset)
        status = job_data.get("status", "running")
        if status in ("completed", "failed", "cancelled"):
            # Final pass — capture any metrics written between last poll and process exit
            await _read_metrics_file_chunk(job_id, metrics_path, job_data, offset)
            break
        await asyncio.sleep(0.5)


def _sse_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _read_stream(
    stream: asyncio.StreamReader,
    lines_list: list,
    job_data: dict,
    field_prefix: str,
):
    """Read lines from an async stream, updating job_data incrementally.

    Buffers output to Redis Streams for replay (fire-and-forget).
    Metrics are NOT parsed from stdout — use MetricsLogger / PYTORCHRUNNER_METRICS
    for structured metric ingestion so different script formats all work reliably.

    Yields the event loop on every iteration so the uvicorn HTTP server
    stays responsive during heavy MPS workloads that produce rapid output.
    """
    job_id = job_data["job_id"]
    while True:
        try:
            line_bytes = await stream.readline()
        except Exception:
            break
        if not line_bytes:
            break
        line = line_bytes.decode("utf-8", errors="replace")
        lines_list.append(line)

        full_key = f"{field_prefix}_full"
        current_full = job_data.get(full_key, "")
        new_full = current_full + line
        if len(new_full) > FULL_MAX_BYTES:
            new_full = new_full[-FULL_MAX_BYTES:]
        job_data[full_key] = new_full

        preview_key = f"{field_prefix}_preview"
        job_data[preview_key] = new_full[-PREVIEW_MAX_BYTES:]
        job_data[f"{field_prefix}_line_count"] = len(lines_list)
        job_data["updated_at"] = datetime.utcnow().isoformat()

        if field_prefix == "stdout":
            asyncio.create_task(_metrics_store.append_stdout(job_id, line))
        else:
            asyncio.create_task(_metrics_store.append_stderr(job_id, line))

        # Yield the event loop so HTTP handlers stay responsive during
        # heavy MPS workloads that produce rapid output.
        await asyncio.sleep(0)


async def execute_script(job_id: str):
    """Background coroutine that runs the script subprocess."""
    try:
        job_data = jobs_db[job_id]
        now = datetime.utcnow().isoformat()

        job_data["status"] = "running"
        job_data["progress"] = 0.1
        job_data["started_at"] = now
        job_data["updated_at"] = now

        await job_store.update_job(
            job_id,
            {"status": "running", "progress": 0.1, "started_at": now, "updated_at": now},
        )

        stdout_lines: List[str] = []
        stderr_lines: List[str] = []
        job_data["_stdout_lines"] = stdout_lines
        job_data["_stderr_lines"] = stderr_lines

        logger.info("Executing job %s: %s", job_id, job_data["script"])

        env = os.environ.copy()
        env_vars = job_data.get("env_vars", {})
        if isinstance(env_vars, dict):
            env.update(env_vars)
        env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
        env["PYTHONUNBUFFERED"] = "1"

        # ── Metrics file sidecar ──────────────────────────────────────────
        # Scripts can write JSONL metrics to this path for high-frequency
        # or structured metrics without cluttering stdout.
        # Example: {"loss": 0.312, "accuracy": 0.876, "step": 100}
        metrics_dir = f"/tmp/pytorchrunner/{job_id}"
        os.makedirs(metrics_dir, exist_ok=True)
        metrics_file = os.path.join(metrics_dir, "metrics.jsonl")
        env["PYTORCHRUNNER_METRICS"] = metrics_file
        env["PYTORCHRUNNER_JOB_ID"] = job_id

        cmd = [sys.executable, "-u", job_data["script"]] + job_data["args"]
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=job_data["cwd"],
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        processes_db[job_id] = process

        # Start metrics file watcher as a background task so it can keep
        # tailing after streams close (scripts may flush file after exit)
        metrics_watcher = asyncio.create_task(
            _watch_metrics_file(job_id, metrics_file, job_data)
        )

        _gather = asyncio.gather(
            _read_stream(process.stdout, stdout_lines, job_data, "stdout"),
            _read_stream(process.stderr, stderr_lines, job_data, "stderr"),
        )
        try:
            if JOB_TIMEOUT is not None:
                await asyncio.wait_for(_gather, timeout=JOB_TIMEOUT)
            else:
                await _gather
        except asyncio.TimeoutError:
            logger.warning(
                "Job %s exceeded timeout of %.0fs — terminating process",
                job_id, JOB_TIMEOUT,
            )
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=10)
            except asyncio.TimeoutError:
                process.kill()
            now_iso = datetime.utcnow().isoformat()
            job_data.update(
                status="failed",
                progress=0.0,
                error=f"Job exceeded timeout of {JOB_TIMEOUT:.0f}s",
                completed_at=now_iso,
                updated_at=now_iso,
            )
            processes_db.pop(job_id, None)
            await job_store.update_job(
                job_id,
                {
                    "status": "failed",
                    "progress": 0.0,
                    "error": job_data["error"],
                    "completed_at": now_iso,
                    "updated_at": now_iso,
                },
            )
            metrics_watcher.cancel()
            return

        await process.wait()
        # Let the file watcher do its final pass (it exits once status is set)
        # We cancel after a short grace period in case the task is stuck
        try:
            await asyncio.wait_for(metrics_watcher, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            metrics_watcher.cancel()
        exit_code = process.returncode
        processes_db.pop(job_id, None)

        final_status = "completed" if exit_code == 0 else "failed"
        now = datetime.utcnow().isoformat()
        job_data.update(
            status=final_status,
            progress=1.0 if exit_code == 0 else 0.0,
            exit_code=exit_code,
            completed_at=now,
            updated_at=now,
        )
        if exit_code != 0 and job_data.get("stderr_full"):
            job_data["error"] = job_data["stderr_full"][-500:]

        # Persist final state including previews (SQLite)
        await job_store.update_job(
            job_id,
            {
                "status": final_status,
                "progress": job_data["progress"],
                "exit_code": exit_code,
                "completed_at": now,
                "updated_at": now,
                "stdout_preview": job_data.get("stdout_preview", ""),
                "stderr_preview": job_data.get("stderr_preview", ""),
                "error": job_data.get("error"),
            },
        )

        # PostgreSQL: update status
        await _experiment_store.update_status(
            job_id, final_status, job_data["progress"],
            exit_code=exit_code, error=job_data.get("error"),
        )

        # Persist full stdout/stderr as artifact files
        stdout_path = await _artifact_store.save_log(
            job_id, "stdout", job_data.get("stdout_full", "")
        )
        stderr_path = await _artifact_store.save_log(
            job_id, "stderr", job_data.get("stderr_full", "")
        )
        await _experiment_store.update_output_preview(
            job_id,
            stdout_preview=job_data.get("stdout_preview", ""),
            stderr_preview=job_data.get("stderr_preview", ""),
            stdout_path=stdout_path,
            stderr_path=stderr_path,
        )

        # Set TTL on Redis output streams (auto-cleanup after 24h)
        await _metrics_store.set_experiment_ttl(job_id)

        # Pick up result JSON files written by the training script
        # Scans: {cwd}/results/*.json and {cwd}/out/results/*.json
        cwd = job_data.get("cwd", "")
        if cwd:
            import glob as _glob
            result_patterns = [
                os.path.join(cwd, "results", "*.json"),
                os.path.join(cwd, "out", "results", "*.json"),
            ]
            for pattern in result_patterns:
                for result_path in _glob.glob(pattern):
                    try:
                        file_size = os.path.getsize(result_path)
                        await _artifact_store._register_artifact(
                            experiment_id=job_id,
                            name=os.path.basename(result_path),
                            artifact_type="result",
                            file_path=result_path,
                            file_size=file_size,
                        )
                        logger.info("Registered result artifact: %s", result_path)
                    except Exception as exc:
                        logger.debug("Failed to register result artifact %s: %s", result_path, exc)

        logger.info(
            "Job %s %s (exit=%s, stdout=%d lines, stderr=%d lines)",
            job_id, final_status, exit_code, len(stdout_lines), len(stderr_lines),
        )

    except Exception as exc:
        logger.error("Job %s failed with exception: %s", job_id, exc)
        now = datetime.utcnow().isoformat()
        jobs_db[job_id].update(
            status="failed",
            progress=0.0,
            exit_code=-1,
            error=str(exc),
            completed_at=now,
            updated_at=now,
        )
        await job_store.update_job(
            job_id,
            {
                "status": "failed",
                "exit_code": -1,
                "error": str(exc),
                "completed_at": now,
                "updated_at": now,
            },
        )
        await _experiment_store.update_status(
            job_id, "failed", 0.0, exit_code=-1, error=str(exc)
        )


# ---------------------------------------------------------------------------
# Experiment management endpoints (PostgreSQL-backed, with filtering/search)
# ---------------------------------------------------------------------------


@app.get("/experiments", summary="List experiments with full-text search and tag filtering")
async def list_experiments(
    status: Optional[str] = Query(None, description="Filter by status"),
    tags: Optional[str] = Query(None, description="Comma-separated tag filter (AND logic)"),
    search: Optional[str] = Query(None, description="Full-text search (name, script, tags)"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """
    List experiments from PostgreSQL with advanced filtering.

    - **tags**: ``?tags=pytorch,gpt`` — returns only experiments with ALL listed tags
    - **search**: ``?search=lstm training`` — full-text search across name/script/tags
    - Falls back to empty list gracefully when PostgreSQL is unavailable.
    """
    tag_list = [t.strip() for t in tags.split(",")] if tags else None
    experiments = await _experiment_store.list(
        status=status, tags=tag_list, search=search, limit=limit, offset=offset
    )
    return [e.model_dump() for e in experiments]


@app.get("/experiments/groups", summary="List experiments grouped by namespace")
async def list_experiment_groups(limit: int = Query(500, ge=1, le=2000)):
    """
    Return all experiments grouped by namespace (project).
    Falls back to SQLite when PostgreSQL is unavailable.
    """
    import statistics as _stats

    # Try PostgreSQL first; fall back to SQLite
    if _db.is_connected:
        all_exps = await _experiment_store.list(limit=limit)
        raw = [e.model_dump() for e in all_exps]
    else:
        raw = await job_store.list_jobs(limit=limit)

    # Group by namespace
    groups: Dict[str, list] = {}
    for exp in raw:
        ns = exp.get("namespace") or "default"
        groups.setdefault(ns, []).append(exp)

    result = []
    for name, runs in groups.items():
        statuses: Dict[str, int] = {}
        for r in runs:
            s = r.get("status", "unknown")
            statuses[s] = statuses.get(s, 0) + 1
        result.append({"name": name, "count": len(runs), "status_counts": statuses})

    result.sort(key=lambda g: g["count"], reverse=True)
    return {"groups": result, "total_runs": len(raw)}


@app.get("/experiments/groups/{group}/summary", summary="Aggregated stats for a run group")
async def get_experiment_group_summary(group: str, limit: int = Query(500, ge=1, le=2000)):
    """
    Aggregated statistics for all runs in a namespace group:
    count by status, best/mean/std per metric, hyperparameter ranges.
    Falls back to SQLite when PostgreSQL is unavailable.
    """
    import statistics as _stats

    if _db.is_connected:
        all_exps = await _experiment_store.list(limit=limit)
        raw = [e.model_dump() for e in all_exps if (e.namespace or "default") == group]
    else:
        all_raw = await job_store.list_jobs(limit=limit)
        raw = [r for r in all_raw if (r.get("namespace") or "default") == group]

    if not raw:
        raise HTTPException(status_code=404, detail=f"Group '{group}' not found")

    # Status breakdown
    status_counts: Dict[str, int] = {}
    for r in raw:
        s = r.get("status", "unknown")
        status_counts[s] = status_counts.get(s, 0) + 1

    # Aggregate final metrics (from metrics_summary)
    all_metrics: Dict[str, List[float]] = {}
    for r in raw:
        ms = r.get("metrics_summary") or {}
        for k, v in ms.items():
            if isinstance(v, (int, float)):
                all_metrics.setdefault(k, []).append(float(v))

    metric_stats: Dict[str, Any] = {}
    for metric, values in all_metrics.items():
        if not values:
            continue
        is_loss = "loss" in metric.lower() or "error" in metric.lower()
        metric_stats[metric] = {
            "best": min(values) if is_loss else max(values),
            "worst": max(values) if is_loss else min(values),
            "mean": _stats.mean(values),
            "std": _stats.stdev(values) if len(values) > 1 else 0.0,
            "min": min(values),
            "max": max(values),
            "count": len(values),
        }

    # Hyperparameter ranges (from env_vars — string keys/values)
    hp_values: Dict[str, List[Any]] = {}
    for r in raw:
        ev = r.get("env_vars") or {}
        if isinstance(ev, dict):
            for k, v in ev.items():
                try:
                    hp_values.setdefault(k, []).append(float(v))
                except (TypeError, ValueError):
                    pass  # skip non-numeric

    hp_ranges: Dict[str, Any] = {}
    for hp, vals in hp_values.items():
        if vals:
            hp_ranges[hp] = {"min": min(vals), "max": max(vals), "count": len(vals)}

    return {
        "group": group,
        "total": len(raw),
        "status_counts": status_counts,
        "metric_stats": metric_stats,
        "hp_ranges": hp_ranges,
        "runs": raw,
    }


@app.get("/experiments/{experiment_id}", summary="Get full experiment record")
async def get_experiment(experiment_id: str):
    """Get full experiment details from PostgreSQL. Falls back to SQLite/memory."""
    exp = await _experiment_store.get(experiment_id)
    if exp:
        return exp.model_dump()
    # Fall back to SQLite
    db_job = await job_store.get_job(experiment_id)
    if db_job:
        return db_job
    if experiment_id in jobs_db:
        return {k: v for k, v in jobs_db[experiment_id].items() if not k.startswith("_")}
    raise HTTPException(status_code=404, detail="Experiment not found")


@app.get("/experiments/{experiment_id}/metrics", summary="Get historical metrics from PostgreSQL")
async def get_experiment_metrics(
    experiment_id: str,
    metric_name: Optional[str] = Query(None, description="Filter to a single metric name"),
    limit: int = Query(1000, ge=1, le=10000),
):
    """
    Retrieve persisted metric observations for an experiment.
    Returns ``{metric_name: [{value, step, recorded_at}]}``.
    """
    return await _experiment_store.get_metrics(experiment_id, name=metric_name, limit=limit)


@app.post("/experiments/{experiment_id}/metrics", summary="Record metrics for an experiment")
async def record_experiment_metrics(
    experiment_id: str,
    metrics: Dict[str, float],
    step: Optional[int] = Query(None),
):
    """
    Manually record metric values for an experiment.
    Writes to both PostgreSQL (persistent) and Redis Streams (real-time).
    """
    await _experiment_store.record_metrics_batch(experiment_id, metrics, step=step)
    await _metrics_store.record_metrics_dict(experiment_id, metrics, step=step)
    return {"recorded": list(metrics.keys()), "step": step}


@app.get(
    "/experiments/{experiment_id}/metrics/stream",
    summary="Poll real-time metrics from Redis Streams",
)
async def get_metrics_realtime(
    experiment_id: str,
    since_id: str = Query("0", description="Redis stream ID cursor (0 = all)"),
    count: int = Query(500, ge=1, le=5000),
):
    """
    Read real-time metrics from Redis Streams. Supports efficient polling:

    1. Call with ``since_id=0`` to get all data
    2. Save the last ``id`` from the response
    3. Poll with ``since_id=<last_id>`` to get only new entries
    """
    return await _metrics_store.get_metrics_stream(
        experiment_id, since_id=since_id, count=count
    )


@app.get("/experiments/{experiment_id}/output/stream", summary="Replay output from Redis Streams")
async def get_output_realtime(
    experiment_id: str,
    stream_type: str = Query("stdout", description="stdout or stderr"),
    since_id: str = Query("0"),
    count: int = Query(500, ge=1, le=5000),
):
    """
    Replay output lines from Redis Streams. Useful for reconnecting after
    SSE disconnect — survives the raw /stream endpoint's in-memory limitation.
    """
    if stream_type not in ("stdout", "stderr"):
        raise HTTPException(status_code=400, detail="stream_type must be stdout or stderr")
    return await _metrics_store.get_output_stream(
        experiment_id, stream_type=stream_type, since_id=since_id, count=count
    )


@app.get("/experiments/{experiment_id}/artifacts", summary="List artifacts for an experiment")
async def get_experiment_artifacts(experiment_id: str):
    """List all registered artifacts (logs, checkpoints, outputs) for an experiment."""
    return await _artifact_store.get_artifacts(experiment_id)


@app.get("/experiments/{experiment_id}/checkpoints", summary="List model checkpoints")
async def get_experiment_checkpoints(experiment_id: str):
    """List model checkpoints registered for an experiment, ordered by epoch."""
    return await _experiment_store.get_checkpoints(experiment_id)


@app.post("/experiments/{experiment_id}/checkpoints", summary="Register a model checkpoint")
async def register_checkpoint(
    experiment_id: str,
    epoch: int = Query(...),
    file_path: str = Query(..., description="Absolute path to checkpoint file"),
    step: Optional[int] = Query(None),
    metrics: Optional[str] = Query(None, description="JSON-encoded metrics dict"),
):
    """Register a model checkpoint file for an experiment."""
    metrics_dict: Dict[str, float] = {}
    if metrics:
        try:
            metrics_dict = json.loads(metrics)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="metrics must be valid JSON")

    stored_path = await _artifact_store.register_checkpoint(
        experiment_id, epoch=epoch, source_path=file_path,
        step=step, metrics=metrics_dict, copy=False,
    )
    return {"experiment_id": experiment_id, "epoch": epoch, "file_path": stored_path}


@app.post("/experiments/{experiment_id}/tags", summary="Add tags to an experiment")
async def add_experiment_tags(experiment_id: str, tags: List[str]):
    """Add one or more tags to an experiment (deduplicates)."""
    await _experiment_store.add_tags(experiment_id, tags)
    return {"experiment_id": experiment_id, "tags_added": tags}


@app.delete("/experiments/{experiment_id}", summary="Delete an experiment and its data")
async def delete_experiment(experiment_id: str):
    """
    Delete an experiment, all artifacts, and Redis streams.
    SQLite and in-memory records are also cleaned up.
    """
    await _experiment_store.delete(experiment_id)
    await _artifact_store.delete_experiment_artifacts(experiment_id)
    await _metrics_store.delete_experiment_streams(experiment_id)
    jobs_db.pop(experiment_id, None)
    return {"deleted": experiment_id}


# ---------------------------------------------------------------------------
# Storage health and maintenance
# ---------------------------------------------------------------------------


@app.get("/storage/health", summary="Storage subsystem health and statistics")
async def storage_health():
    """
    Returns health and capacity stats for all storage backends:
    PostgreSQL, Redis Streams, and the artifact filesystem.
    """
    stats = await _artifact_store.get_storage_stats()
    experiment_count = await _experiment_store.count()
    return {
        "postgres_connected": _db.is_connected,
        "redis_connected": _metrics_store.is_connected,
        "sqlite_path": job_store.db_path,
        "artifact_store_path": stats.get("base_path"),
        "artifact_store_writable": stats.get("writable", False),
        "artifact_store_mb": stats.get("total_mb", 0),
        "artifact_count": stats.get("artifact_count", 0),
        "total_experiments_postgres": experiment_count,
        "total_jobs_memory": len(jobs_db),
    }


@app.post("/storage/cleanup", summary="Run storage cleanup policies")
async def run_storage_cleanup(
    max_experiment_age_days: int = Query(90, description="Delete experiments older than N days"),
    max_artifact_age_days: int = Query(30, description="Delete artifacts older than N days"),
):
    """
    Run cleanup: delete old experiments (keeping completed/failed) and stale artifacts.
    Suitable for scheduling via cron or periodic task.
    """
    exp_deleted = await _experiment_store.cleanup_old(
        max_age_days=max_experiment_age_days,
        keep_statuses=["completed", "failed"],
    )
    art_deleted = await _artifact_store.cleanup_old_artifacts(
        max_age_days=max_artifact_age_days,
    )
    return {
        "experiments_deleted": exp_deleted,
        "artifacts_deleted": art_deleted,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9100)
