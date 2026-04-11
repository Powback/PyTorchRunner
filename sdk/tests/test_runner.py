"""
Unit tests for JobRunner and Job — all HTTP calls are mocked with responses.mock.
"""
import json
import time
import pytest
import responses

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pytorch_runner import (
    Job,
    JobRunner,
    JobResult,
    JobStatus,
    HealthStatus,
    JobFailedError,
    JobNotFoundError,
    JobSubmissionError,
    JobTimeoutError,
    ServiceUnavailableError,
    RunnerConfig,
)

BASE_URL = "http://test-runner.local:9100"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def runner():
    return JobRunner(base_url=BASE_URL, max_retries=1)


def _queued_job(job_id="abc-123"):
    return {
        "job_id": job_id,
        "script": "train.py",
        "args": ["--lr", "0.01"],
        "cwd": "/workspace",
        "status": "queued",
        "progress": 0.0,
        "created_at": "2024-01-01T00:00:00",
        "updated_at": "2024-01-01T00:00:00",
        "started_at": None,
        "completed_at": None,
        "exit_code": None,
        "stdout_preview": "",
        "stderr_preview": "",
        "stdout_full": "",
        "stderr_full": "",
        "stdout_line_count": 0,
        "stderr_line_count": 0,
        "error": None,
    }


def _completed_job(job_id="abc-123"):
    d = _queued_job(job_id)
    d.update(
        status="completed",
        progress=1.0,
        exit_code=0,
        stdout_full="Training done\n",
        stdout_preview="Training done\n",
        completed_at="2024-01-01T00:01:00",
    )
    return d


def _failed_job(job_id="abc-123"):
    d = _queued_job(job_id)
    d.update(
        status="failed",
        progress=0.0,
        exit_code=1,
        stderr_full="RuntimeError: bad input\n",
        stderr_preview="RuntimeError: bad input\n",
        error="RuntimeError: bad input",
        completed_at="2024-01-01T00:00:30",
    )
    return d


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def test_config_defaults():
    cfg = RunnerConfig()
    assert cfg.base_url == "http://localhost:9100"
    assert cfg.max_retries == 3
    assert cfg.timeout == 30.0


def test_config_from_env(monkeypatch):
    monkeypatch.setenv("PYTORCH_RUNNER_URL", "http://myserver:9100")
    monkeypatch.setenv("PYTORCH_RUNNER_NAMESPACE", "specllm")
    cfg = RunnerConfig.from_env()
    assert cfg.base_url == "http://myserver:9100"
    assert cfg.namespace == "specllm"


def test_config_headers_with_key():
    cfg = RunnerConfig(api_key="secret")
    assert cfg.headers["Authorization"] == "Bearer secret"


def test_config_strips_trailing_slash():
    cfg = RunnerConfig(base_url="http://host:9100/")
    assert cfg.base_url == "http://host:9100"


# ---------------------------------------------------------------------------
# JobRunner — run_script
# ---------------------------------------------------------------------------

@responses.activate
def test_run_script_returns_job(runner):
    responses.add(
        responses.POST, f"{BASE_URL}/run",
        json={"job_id": "abc-123", "status": "queued"},
        status=200,
    )
    job = runner.run_script("train.py", args=["--lr", "0.01"], cwd="/workspace")
    assert isinstance(job, Job)
    assert job.job_id == "abc-123"


@responses.activate
def test_run_script_namespace_prefix(runner):
    runner.config.namespace = "specllm"
    captured = {}

    def request_callback(req):
        captured["body"] = json.loads(req.body)
        return (200, {}, json.dumps({"job_id": "xyz-999", "status": "queued"}))

    responses.add_callback(responses.POST, f"{BASE_URL}/run", callback=request_callback)
    runner.run_script("train.py", cwd="/workspace")
    assert captured["body"]["job_name"] == "specllm/train"


@responses.activate
def test_run_script_api_error_raises(runner):
    responses.add(
        responses.POST, f"{BASE_URL}/run",
        json={"detail": "Working directory does not exist"},
        status=400,
    )
    with pytest.raises(JobSubmissionError):
        runner.run_script("train.py", cwd="/bad/path")


def test_run_script_connection_error(runner):
    with pytest.raises(ServiceUnavailableError):
        runner.run_script("train.py", cwd="/workspace")


# ---------------------------------------------------------------------------
# Job.wait
# ---------------------------------------------------------------------------

@responses.activate
def test_job_wait_polls_until_complete(runner):
    job_id = "abc-123"
    # First poll: running; second poll: completed
    responses.add(responses.GET, f"{BASE_URL}/jobs/{job_id}",
                  json={**_queued_job(job_id), "status": "running", "progress": 0.5})
    responses.add(responses.GET, f"{BASE_URL}/jobs/{job_id}",
                  json=_completed_job(job_id))

    job = Job(job_id, runner)
    result = job.wait(poll_interval=0.01)

    assert isinstance(result, JobResult)
    assert result.status == "completed"
    assert result.exit_code == 0
    assert result.stdout == "Training done\n"
    assert result.succeeded


@responses.activate
def test_job_wait_timeout(runner):
    job_id = "abc-123"
    # Always return running
    for _ in range(10):
        responses.add(responses.GET, f"{BASE_URL}/jobs/{job_id}",
                      json={**_queued_job(job_id), "status": "running"})

    job = Job(job_id, runner)
    with pytest.raises(JobTimeoutError) as exc_info:
        job.wait(poll_interval=0.01, timeout=0.05)
    assert exc_info.value.job_id == job_id


@responses.activate
def test_job_wait_raise_on_failure(runner):
    job_id = "abc-123"
    responses.add(responses.GET, f"{BASE_URL}/jobs/{job_id}", json=_failed_job(job_id))

    job = Job(job_id, runner)
    with pytest.raises(JobFailedError) as exc_info:
        job.wait(poll_interval=0.01, raise_on_failure=True)
    assert exc_info.value.exit_code == 1


@responses.activate
def test_job_result_no_raise_on_failure_by_default(runner):
    job_id = "abc-123"
    responses.add(responses.GET, f"{BASE_URL}/jobs/{job_id}", json=_failed_job(job_id))

    job = Job(job_id, runner)
    result = job.wait(poll_interval=0.01)
    assert result.status == "failed"
    assert not result.succeeded


# ---------------------------------------------------------------------------
# Job.cancel
# ---------------------------------------------------------------------------

@responses.activate
def test_job_cancel(runner):
    job_id = "abc-123"
    responses.add(
        responses.POST, f"{BASE_URL}/jobs/{job_id}/cancel",
        json={"job_id": job_id, "status": "cancelled"},
        status=200,
    )
    job = Job(job_id, runner)
    assert job.cancel() is True


@responses.activate
def test_job_cancel_not_found(runner):
    job_id = "abc-123"
    responses.add(
        responses.POST, f"{BASE_URL}/jobs/{job_id}/cancel",
        json={"detail": "Job not found"},
        status=404,
    )
    job = Job(job_id, runner)
    with pytest.raises(JobNotFoundError):
        job.cancel()


# ---------------------------------------------------------------------------
# Job.get_status
# ---------------------------------------------------------------------------

@responses.activate
def test_get_status(runner):
    job_id = "abc-123"
    responses.add(
        responses.GET, f"{BASE_URL}/jobs/{job_id}",
        json=_completed_job(job_id),
        status=200,
    )
    job = Job(job_id, runner)
    status = job.get_status()
    assert isinstance(status, JobStatus)
    assert status.job_id == job_id
    assert status.is_terminal
    assert status.succeeded


@responses.activate
def test_get_status_not_found(runner):
    job_id = "missing"
    responses.add(
        responses.GET, f"{BASE_URL}/jobs/{job_id}",
        json={"detail": "Job not found"},
        status=404,
    )
    job = Job(job_id, runner)
    with pytest.raises(JobNotFoundError):
        job.get_status()


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@responses.activate
def test_health(runner):
    responses.add(
        responses.GET, f"{BASE_URL}/health",
        json={
            "service": "PyTorchRunner Script Executor",
            "status": "healthy",
            "mps_available": True,
            "queue_size": 0,
            "active_jobs": 1,
            "api_version": "2.2.0",
        },
        status=200,
    )
    h = runner.health()
    assert isinstance(h, HealthStatus)
    assert h.mps_available is True
    assert h.status == "healthy"


# ---------------------------------------------------------------------------
# cancel_all
# ---------------------------------------------------------------------------

@responses.activate
def test_cancel_all(runner):
    responses.add(
        responses.POST, f"{BASE_URL}/jobs/cancel_all",
        json={"cancelled": 3, "job_ids": ["a", "b", "c"]},
        status=200,
    )
    assert runner.cancel_all() == 3


# ---------------------------------------------------------------------------
# Context manager
# ---------------------------------------------------------------------------

@responses.activate
def test_context_manager(runner):
    responses.add(
        responses.POST, f"{BASE_URL}/run",
        json={"job_id": "ctx-job", "status": "queued"},
        status=200,
    )
    with JobRunner(base_url=BASE_URL, max_retries=1) as r:
        job = r.run_script("eval.py", cwd="/workspace")
    assert job.job_id == "ctx-job"


# ---------------------------------------------------------------------------
# JobResult helpers
# ---------------------------------------------------------------------------

def test_job_result_raise_on_failure():
    result = JobResult(
        job_id="x",
        status="failed",
        exit_code=1,
        stdout="",
        stderr="error msg",
        duration=1.0,
        error="error msg",
    )
    with pytest.raises(JobFailedError) as exc_info:
        result.raise_on_failure()
    assert "error msg" in str(exc_info.value)


def test_job_result_no_raise_when_succeeded():
    result = JobResult(
        job_id="x",
        status="completed",
        exit_code=0,
        stdout="done",
        stderr="",
        duration=1.0,
    )
    result.raise_on_failure()  # Should not raise
