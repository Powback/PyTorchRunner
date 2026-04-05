"""
Fixed Script Execution API with Live Output Streaming
"""
import asyncio
import os
import sys
import uuid
import time
import logging
from datetime import datetime
from typing import Dict, Any, Optional, List, AsyncGenerator
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import torch
import json

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# In-memory job storage
jobs_db = {}

# Max bytes to keep in preview fields (backward compat)
PREVIEW_MAX_BYTES = 2000
# Max bytes to keep in full output buffers
FULL_MAX_BYTES = 1_000_000  # 1MB


class ScriptExecutionRequest(BaseModel):
    script: str
    args: List[str] = []
    cwd: str
    env_vars: Dict[str, str] = {}
    job_name: Optional[str] = None

app = FastAPI(title="PyTorchRunner Script Executor", version="2.1.0")

@app.post("/run")
async def run_script(request: ScriptExecutionRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())

    if not os.path.exists(request.cwd):
        raise HTTPException(status_code=400, detail=f"Working directory does not exist: {request.cwd}")

    script_path = os.path.join(request.cwd, request.script)
    if not os.path.exists(script_path):
        raise HTTPException(status_code=400, detail=f"Script not found: {script_path}")

    job_data = {
        "job_id": job_id,
        "script": request.script,
        "args": request.args,
        "cwd": request.cwd,
        "env_vars": request.env_vars,
        "status": "queued",
        "progress": 0.0,
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
        # Backward-compatible preview fields (last 2KB)
        "stdout_preview": "",
        "stderr_preview": "",
        # Full output (up to 1MB)
        "stdout_full": "",
        "stderr_full": "",
        # Line counts for client polling
        "stdout_line_count": 0,
        "stderr_line_count": 0,
        "started_at": None,
        "completed_at": None,
        "exit_code": None,
        "error": None
    }

    jobs_db[job_id] = job_data

    # Use asyncio.create_task for reliable background execution
    asyncio.create_task(execute_script(job_id))

    logger.info(f"Queued job {job_id}: {request.script}")
    return {"job_id": job_id, "status": "queued"}

@app.get("/jobs/{job_id}")
async def get_job_status(job_id: str):
    if job_id not in jobs_db:
        raise HTTPException(status_code=404, detail="Job not found")

    # Return copy to avoid reference issues
    return dict(jobs_db[job_id])

@app.get("/jobs/{job_id}/stream")
async def stream_job_output(job_id: str, since_line: int = 0):
    """
    Server-Sent Events endpoint for real-time job output streaming.

    Streams stdout/stderr lines as they are produced.
    Connect with: curl -N http://localhost:9100/jobs/{job_id}/stream

    Optional query param `since_line` to resume from a specific line number.
    Each SSE event has data as JSON: {"type": "stdout"|"stderr"|"status", "line": str, "line_no": int}
    A final event with type="done" is sent when job completes.
    """
    if job_id not in jobs_db:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator() -> AsyncGenerator[str, None]:
        job = jobs_db[job_id]
        sent_stdout = since_line
        sent_stderr = 0

        # Send initial status
        yield _sse_event({"type": "status", "status": job["status"], "job_id": job_id})

        while True:
            job = jobs_db.get(job_id)
            if job is None:
                break

            # Stream any new stdout lines
            stdout_lines = job.get("_stdout_lines", [])
            while sent_stdout < len(stdout_lines):
                line = stdout_lines[sent_stdout]
                yield _sse_event({"type": "stdout", "line": line, "line_no": sent_stdout})
                sent_stdout += 1

            # Stream any new stderr lines
            stderr_lines = job.get("_stderr_lines", [])
            while sent_stderr < len(stderr_lines):
                line = stderr_lines[sent_stderr]
                yield _sse_event({"type": "stderr", "line": line, "line_no": sent_stderr})
                sent_stderr += 1

            # Check if job is done
            status = job.get("status", "queued")
            if status in ("completed", "failed", "cancelled"):
                yield _sse_event({
                    "type": "done",
                    "status": status,
                    "exit_code": job.get("exit_code"),
                    "stdout_lines": len(stdout_lines),
                    "stderr_lines": len(stderr_lines)
                })
                break

            # Poll interval - short enough for responsive streaming
            await asyncio.sleep(0.1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        }
    )

@app.get("/health")
async def health_check():
    mps_available = torch.backends.mps.is_available()

    return {
        "service": "PyTorchRunner Script Executor",
        "status": "healthy",
        "mps_available": mps_available,
        "queue_size": len([j for j in jobs_db.values() if j["status"] == "queued"]),
        "active_jobs": len([j for j in jobs_db.values() if j["status"] == "running"]),
        "api_version": "2.1.0"
    }


def _sse_event(data: dict) -> str:
    """Format a dict as an SSE event string."""
    return f"data: {json.dumps(data)}\n\n"


async def _read_stream(stream: asyncio.StreamReader, lines_list: list, job_data: dict,
                       field_prefix: str):
    """
    Reads lines from an async stream, appending each to lines_list and
    updating the job_data preview/full fields incrementally.
    """
    while True:
        try:
            line_bytes = await stream.readline()
        except Exception:
            break
        if not line_bytes:
            break
        line = line_bytes.decode("utf-8", errors="replace")
        lines_list.append(line)

        # Update full output (capped at FULL_MAX_BYTES)
        full_key = f"{field_prefix}_full"
        current_full = job_data.get(full_key, "")
        new_full = current_full + line
        if len(new_full) > FULL_MAX_BYTES:
            new_full = new_full[-FULL_MAX_BYTES:]
        job_data[full_key] = new_full

        # Update preview (last PREVIEW_MAX_BYTES, backward compat)
        preview_key = f"{field_prefix}_preview"
        job_data[preview_key] = new_full[-PREVIEW_MAX_BYTES:]

        # Update line count
        job_data[f"{field_prefix}_line_count"] = len(lines_list)

        # Touch updated_at so pollers see activity
        job_data["updated_at"] = datetime.utcnow().isoformat()


async def execute_script(job_id: str):
    try:
        job_data = jobs_db[job_id]

        # Update to running
        job_data["status"] = "running"
        job_data["progress"] = 0.1
        job_data["started_at"] = datetime.utcnow().isoformat()
        job_data["updated_at"] = datetime.utcnow().isoformat()

        # Internal line buffers for SSE streaming
        stdout_lines: List[str] = []
        stderr_lines: List[str] = []
        job_data["_stdout_lines"] = stdout_lines
        job_data["_stderr_lines"] = stderr_lines

        logger.info(f"Executing job {job_id}: {job_data['script']}")

        # Prepare environment
        env = os.environ.copy()
        env_vars = job_data.get("env_vars", {})
        if isinstance(env_vars, dict):
            env.update(env_vars)
        env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
        # Unbuffer Python output so lines arrive in real-time
        env["PYTHONUNBUFFERED"] = "1"

        # Build command
        cmd = [sys.executable, "-u", job_data["script"]] + job_data["args"]

        # Execute
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=job_data["cwd"],
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        # Stream stdout and stderr concurrently in real-time
        await asyncio.gather(
            _read_stream(process.stdout, stdout_lines, job_data, "stdout"),
            _read_stream(process.stderr, stderr_lines, job_data, "stderr"),
        )

        # Wait for process to finish (should be instant after streams close)
        await process.wait()
        exit_code = process.returncode

        # Update final status
        job_data["status"] = "completed" if exit_code == 0 else "failed"
        job_data["progress"] = 1.0 if exit_code == 0 else 0.0
        job_data["exit_code"] = exit_code
        job_data["completed_at"] = datetime.utcnow().isoformat()
        job_data["updated_at"] = datetime.utcnow().isoformat()

        stderr_text = job_data.get("stderr_full", "")
        if exit_code != 0 and stderr_text:
            job_data["error"] = stderr_text[-500:]

        logger.info(f"Job {job_id} completed with exit code {exit_code}, "
                    f"stdout={len(stdout_lines)} lines, stderr={len(stderr_lines)} lines")

    except Exception as e:
        logger.error(f"Job {job_id} failed: {e}")
        jobs_db[job_id].update({
            "status": "failed",
            "progress": 0.0,
            "exit_code": -1,
            "error": str(e),
            "completed_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        })

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9100)
