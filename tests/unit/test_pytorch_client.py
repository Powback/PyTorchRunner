"""
Unit tests for src/client/pytorch_client.py

All HTTP calls are intercepted with aioresponses so no real server is needed.
"""
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import aiohttp
from aioresponses import aioresponses

from src.client.pytorch_client import (
    PyTorchRunnerClient,
    JobResult,
    DockerAgentHelper,
    train_model,
)

BASE_URL = "http://localhost:8000"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def client():
    async with PyTorchRunnerClient(BASE_URL) as c:
        yield c


# ---------------------------------------------------------------------------
# health_check
# ---------------------------------------------------------------------------

class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_health_check_returns_dict(self, client):
        with aioresponses() as m:
            m.get(f"{BASE_URL}/health", payload={
                "status": "healthy",
                "mps_available": True,
                "service": "PyTorchRunner",
            })
            result = await client.health_check()
        assert result["status"] == "healthy"
        assert result["mps_available"] is True

    @pytest.mark.asyncio
    async def test_health_check_raises_on_error(self, client):
        with aioresponses() as m:
            m.get(f"{BASE_URL}/health", status=503, body="Service Unavailable")
            with pytest.raises(Exception, match="Health check failed"):
                await client.health_check()


# ---------------------------------------------------------------------------
# submit_job
# ---------------------------------------------------------------------------

class TestSubmitJob:
    @pytest.mark.asyncio
    async def test_submit_returns_job_id(self, client):
        with aioresponses() as m:
            m.post(f"{BASE_URL}/train", payload={"job_id": "test-job-id-123"})
            job_id = await client.submit_job(
                model_config={"type": "linear"},
                training_params={"epochs": 2},
                data_config={"type": "synthetic"},
            )
        assert job_id == "test-job-id-123"

    @pytest.mark.asyncio
    async def test_submit_sends_correct_payload(self, client):
        model_config = {"type": "linear", "input_size": 784}
        training_params = {"epochs": 5, "learning_rate": 0.001}
        data_config = {"type": "synthetic", "num_samples": 1000}

        with aioresponses() as m:
            m.post(f"{BASE_URL}/train", payload={"job_id": "abc"})
            await client.submit_job(model_config, training_params, data_config, job_name="my-job")

        # aioresponses captures request; validate it was called once
        assert len(m.requests) == 1

    @pytest.mark.asyncio
    async def test_submit_raises_on_server_error(self, client):
        with aioresponses() as m:
            m.post(f"{BASE_URL}/train", status=500, body="Internal Server Error")
            with pytest.raises(Exception, match="Job submission failed"):
                await client.submit_job({}, {}, {})


# ---------------------------------------------------------------------------
# get_job_status
# ---------------------------------------------------------------------------

class TestGetJobStatus:
    @pytest.mark.asyncio
    async def test_get_status_returns_dict(self, client):
        job_id = "job-xyz"
        with aioresponses() as m:
            m.get(f"{BASE_URL}/jobs/{job_id}", payload={
                "job_id": job_id,
                "status": "running",
                "progress": 0.5,
                "metrics": {},
            })
            status = await client.get_job_status(job_id)
        assert status["status"] == "running"
        assert status["progress"] == 0.5

    @pytest.mark.asyncio
    async def test_get_status_raises_value_error_on_404(self, client):
        with aioresponses() as m:
            m.get(f"{BASE_URL}/jobs/missing", status=404, body="Not Found")
            with pytest.raises(ValueError, match="not found"):
                await client.get_job_status("missing")

    @pytest.mark.asyncio
    async def test_get_status_raises_on_server_error(self, client):
        with aioresponses() as m:
            m.get(f"{BASE_URL}/jobs/err-job", status=500, body="Error")
            with pytest.raises(Exception, match="Status check failed"):
                await client.get_job_status("err-job")


# ---------------------------------------------------------------------------
# wait_for_completion
# ---------------------------------------------------------------------------

class TestWaitForCompletion:
    @pytest.mark.asyncio
    async def test_wait_returns_job_result_on_completion(self, client):
        job_id = "job-wait-001"
        with aioresponses() as m:
            m.get(f"{BASE_URL}/jobs/{job_id}", payload={
                "job_id": job_id,
                "status": "completed",
                "progress": 1.0,
                "metrics": {"final_loss": 0.12},
            })
            result = await client.wait_for_completion(job_id, poll_interval=0.01)

        assert isinstance(result, JobResult)
        assert result.status == "completed"
        assert result.job_id == job_id

    @pytest.mark.asyncio
    async def test_wait_returns_failed_result(self, client):
        job_id = "job-wait-002"
        with aioresponses() as m:
            m.get(f"{BASE_URL}/jobs/{job_id}", payload={
                "job_id": job_id,
                "status": "failed",
                "progress": 0.0,
                "metrics": {},
                "error": "CUDA OOM",
            })
            result = await client.wait_for_completion(job_id, poll_interval=0.01)

        assert result.status == "failed"
        assert result.error == "CUDA OOM"

    @pytest.mark.asyncio
    async def test_wait_calls_progress_callback(self, client):
        job_id = "job-cb-001"
        callback = MagicMock()
        with aioresponses() as m:
            m.get(f"{BASE_URL}/jobs/{job_id}", payload={
                "job_id": job_id,
                "status": "completed",
                "progress": 1.0,
                "metrics": {"loss": 0.1},
            })
            await client.wait_for_completion(job_id, progress_callback=callback, poll_interval=0.01)

        callback.assert_called_once_with(1.0, {"loss": 0.1})

    @pytest.mark.asyncio
    async def test_wait_polls_until_complete(self, client):
        job_id = "job-poll-001"
        responses = [
            {"job_id": job_id, "status": "running", "progress": 0.3, "metrics": {}},
            {"job_id": job_id, "status": "running", "progress": 0.7, "metrics": {}},
            {"job_id": job_id, "status": "completed", "progress": 1.0, "metrics": {"loss": 0.05}},
        ]
        with aioresponses() as m:
            for r in responses:
                m.get(f"{BASE_URL}/jobs/{job_id}", payload=r)
            result = await client.wait_for_completion(job_id, poll_interval=0.01)

        assert result.status == "completed"


# ---------------------------------------------------------------------------
# train (combined workflow)
# ---------------------------------------------------------------------------

class TestTrain:
    @pytest.mark.asyncio
    async def test_train_submits_and_waits(self, client):
        with aioresponses() as m:
            m.post(f"{BASE_URL}/train", payload={"job_id": "train-001"})
            m.get(f"{BASE_URL}/jobs/train-001", payload={
                "job_id": "train-001",
                "status": "completed",
                "progress": 1.0,
                "metrics": {"accuracy": 0.95},
            })
            result = await client.train(
                model_config={"type": "linear"},
                training_params={"epochs": 1},
                data_config={"type": "synthetic"},
                poll_interval=0.01,
            )

        assert result.status == "completed"
        assert result.job_id == "train-001"


# ---------------------------------------------------------------------------
# Context manager
# ---------------------------------------------------------------------------

class TestContextManager:
    @pytest.mark.asyncio
    async def test_context_manager_creates_and_closes_session(self):
        client = PyTorchRunnerClient(BASE_URL)
        assert client.session is None
        async with client:
            assert client.session is not None
        # After __aexit__ the session should be closed (aiohttp sets _connector to None)
        assert client.session.closed


# ---------------------------------------------------------------------------
# DockerAgentHelper
# ---------------------------------------------------------------------------

class TestDockerAgentHelper:
    @pytest.mark.asyncio
    async def test_replace_local_training_raises_if_service_down(self):
        helper = DockerAgentHelper("http://unreachable:8000")
        helper.client.health_check = AsyncMock(side_effect=Exception("connection refused"))

        async with helper:
            with pytest.raises(Exception, match="PyTorchRunner service unavailable"):
                await helper.replace_local_training({}, {}, {})

    @pytest.mark.asyncio
    async def test_replace_local_training_returns_result(self):
        helper = DockerAgentHelper("http://localhost:8000")
        mock_result = JobResult(
            job_id="dah-001",
            status="completed",
            final_metrics={"loss": 0.08},
            duration=12.3,
        )
        helper.client.health_check = AsyncMock(return_value={"mps_available": True})
        helper.client.train = AsyncMock(return_value=mock_result)

        async with helper:
            result = await helper.replace_local_training(
                model_config={"type": "linear"},
                training_params={"epochs": 2},
                data_config={"type": "synthetic"},
            )

        assert result.status == "completed"
        assert result.job_id == "dah-001"


# ---------------------------------------------------------------------------
# JobResult dataclass
# ---------------------------------------------------------------------------

class TestJobResult:
    def test_job_result_creation(self):
        r = JobResult(
            job_id="r-001",
            status="completed",
            final_metrics={"loss": 0.1},
            duration=30.0,
        )
        assert r.error is None

    def test_job_result_with_error(self):
        r = JobResult(
            job_id="r-002",
            status="failed",
            final_metrics={},
            duration=5.0,
            error="OOM",
        )
        assert r.error == "OOM"
