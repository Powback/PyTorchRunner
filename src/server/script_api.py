"""
Script Execution API for PyTorchRunner  — v3.0.0
Persistent job history, namespace support, and safe multi-agent cancellation.
"""
import asyncio
import json
import logging
import os
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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

# Persistent store
job_store = JobStore()

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
    logger.info("PyTorchRunner Script Executor ready (persistent store: %s)", job_store.db_path)


@app.on_event("shutdown")
async def _shutdown():
    await job_store.close()


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

    # Persist metadata immediately so it survives a restart
    await job_store.save_job(job_data)

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

            if job.get("status") in ("completed", "failed", "cancelled"):
                yield _sse_event(
                    {
                        "type": "done",
                        "status": job["status"],
                        "exit_code": job.get("exit_code"),
                        "stdout_lines": len(stdout_lines),
                        "stderr_lines": len(stderr_lines),
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


def _sse_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _read_stream(
    stream: asyncio.StreamReader,
    lines_list: list,
    job_data: dict,
    field_prefix: str,
):
    """Read lines from an async stream, updating job_data incrementally."""
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

        cmd = [sys.executable, "-u", job_data["script"]] + job_data["args"]
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=job_data["cwd"],
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        processes_db[job_id] = process

        await asyncio.gather(
            _read_stream(process.stdout, stdout_lines, job_data, "stdout"),
            _read_stream(process.stderr, stderr_lines, job_data, "stderr"),
        )

        await process.wait()
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

        # Persist final state including previews
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9100)
