"""
Unit tests for src/queue/redis_queue.py

Uses fakeredis to provide an in-memory Redis backend — no real Redis required.
"""
import json
import pytest
import pytest_asyncio
from datetime import datetime
from unittest.mock import AsyncMock, patch, MagicMock

import fakeredis.aioredis as fakeredis_async
from src.queue.redis_queue import JobQueue


@pytest_asyncio.fixture
async def queue():
    """JobQueue wired to an in-memory fakeredis instance."""
    q = JobQueue()
    fake_redis = fakeredis_async.FakeRedis(decode_responses=True)
    q.redis = fake_redis
    yield q
    await fake_redis.aclose()


def _sample_job(job_id="job-abc123"):
    return {
        "job_id": job_id,
        "script": "train.py",
        "args": ["--epochs", "5"],
        "cwd": "/workspace",
        "status": "queued",
        "progress": 0.0,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
        "stdout_preview": "",
        "stderr_preview": "",
    }


# ---------------------------------------------------------------------------
# connect / disconnect
# ---------------------------------------------------------------------------

class TestConnectDisconnect:
    @pytest.mark.asyncio
    async def test_connect_calls_ping(self):
        q = JobQueue()
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(return_value=True)
        with patch("fakeredis.aioredis.FakeRedis") as mock_cls:
            mock_cls.return_value = mock_redis
            with patch("src.queue.redis_queue.aioredis.from_url", return_value=mock_redis):
                await q.connect()
        mock_redis.ping.assert_called_once()

    @pytest.mark.asyncio
    async def test_disconnect_closes_redis(self):
        q = JobQueue()
        mock_redis = AsyncMock()
        q.redis = mock_redis
        await q.disconnect()
        mock_redis.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_operations_without_connect_raise(self):
        q = JobQueue()  # redis is None
        with pytest.raises(RuntimeError, match="Redis not connected"):
            await q.enqueue_job("id", {})


# ---------------------------------------------------------------------------
# enqueue / get
# ---------------------------------------------------------------------------

class TestEnqueueAndGet:
    @pytest.mark.asyncio
    async def test_enqueue_stores_job(self, queue):
        job_id = "job-001"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        stored = await queue.get_job_status(job_id)
        assert stored is not None
        assert stored["job_id"] == job_id

    @pytest.mark.asyncio
    async def test_enqueue_adds_to_queue_list(self, queue):
        job_id = "job-002"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        size = await queue.get_queue_size()
        assert size == 1

    @pytest.mark.asyncio
    async def test_get_nonexistent_job_returns_none(self, queue):
        result = await queue.get_job_status("does-not-exist")
        assert result is None

    @pytest.mark.asyncio
    async def test_enqueue_multiple_jobs(self, queue):
        for i in range(5):
            await queue.enqueue_job(f"job-{i}", _sample_job(f"job-{i}"))
        assert await queue.get_queue_size() == 5

    @pytest.mark.asyncio
    async def test_stored_job_preserves_fields(self, queue):
        job_id = "job-fields"
        job = _sample_job(job_id)
        job["args"] = ["--lr", "0.001"]
        await queue.enqueue_job(job_id, job)
        stored = await queue.get_job_status(job_id)
        assert stored["script"] == "train.py"
        assert stored["cwd"] == "/workspace"


# ---------------------------------------------------------------------------
# dequeue
# ---------------------------------------------------------------------------

class TestDequeue:
    @pytest.mark.asyncio
    async def test_dequeue_returns_job_id(self, queue):
        job_id = "job-dq-001"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        result = await queue.dequeue_job()
        assert result == job_id

    @pytest.mark.asyncio
    async def test_dequeue_empty_queue_returns_none(self, queue):
        result = await queue.dequeue_job()
        assert result is None

    @pytest.mark.asyncio
    async def test_dequeue_moves_to_active(self, queue):
        job_id = "job-dq-002"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        await queue.dequeue_job()
        active = await queue.get_active_job_count()
        assert active == 1
        queue_size = await queue.get_queue_size()
        assert queue_size == 0


# ---------------------------------------------------------------------------
# update_job_status
# ---------------------------------------------------------------------------

class TestUpdateJobStatus:
    @pytest.mark.asyncio
    async def test_update_status_to_running(self, queue):
        job_id = "job-upd-001"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        await queue.update_job_status(job_id, "running", 0.1)
        stored = await queue.get_job_status(job_id)
        assert stored["status"] == "running"

    @pytest.mark.asyncio
    async def test_update_progress_value(self, queue):
        job_id = "job-upd-002"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        await queue.update_job_status(job_id, "running", 0.75)
        stored = await queue.get_job_status(job_id)
        assert abs(stored["progress"] - 0.75) < 0.001

    @pytest.mark.asyncio
    async def test_update_status_with_error(self, queue):
        job_id = "job-upd-003"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        await queue.update_job_status(job_id, "failed", 0.0, error="OOM error")
        stored = await queue.get_job_status(job_id)
        assert stored["status"] == "failed"
        assert stored["error"] == "OOM error"

    @pytest.mark.asyncio
    async def test_completed_job_removed_from_active(self, queue):
        job_id = "job-upd-004"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        await queue.dequeue_job()  # moves to active
        await queue.update_job_status(job_id, "completed", 1.0)
        active = await queue.get_active_job_count()
        assert active == 0


# ---------------------------------------------------------------------------
# update_job_progress
# ---------------------------------------------------------------------------

class TestUpdateJobProgress:
    @pytest.mark.asyncio
    async def test_update_progress_and_metrics(self, queue):
        job_id = "job-prog-001"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        metrics = {"loss": 0.42, "accuracy": 0.87, "epoch": 3}
        await queue.update_job_progress(job_id, 0.6, metrics)
        stored = await queue.get_job_status(job_id)
        assert abs(stored["progress"] - 0.6) < 0.001


# ---------------------------------------------------------------------------
# update_job_fields
# ---------------------------------------------------------------------------

class TestUpdateJobFields:
    @pytest.mark.asyncio
    async def test_update_arbitrary_fields(self, queue):
        job_id = "job-fld-001"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        await queue.update_job_fields(job_id, {
            "stdout_preview": "Training epoch 1...",
            "exit_code": 0,
        })
        stored = await queue.get_job_status(job_id)
        assert stored["stdout_preview"] == "Training epoch 1..."

    @pytest.mark.asyncio
    async def test_update_dict_field_serializes_as_json(self, queue):
        job_id = "job-fld-002"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        await queue.update_job_fields(job_id, {"config": {"lr": 0.001}})
        # Raw value in redis should be JSON string
        raw = await queue.redis.hget(f"{queue.job_prefix}{job_id}", "config")
        assert json.loads(raw) == {"lr": 0.001}


# ---------------------------------------------------------------------------
# cleanup_job
# ---------------------------------------------------------------------------

class TestCleanupJob:
    @pytest.mark.asyncio
    async def test_cleanup_removes_job_data(self, queue):
        job_id = "job-clean-001"
        await queue.enqueue_job(job_id, _sample_job(job_id))
        await queue.cleanup_job(job_id)
        stored = await queue.get_job_status(job_id)
        assert stored is None


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

class TestSerialization:
    def test_serialize_datetime(self):
        q = JobQueue()
        now = datetime.utcnow()
        result = q._serialize_job_data({"created_at": now})
        assert result["created_at"] == now.isoformat()

    def test_serialize_dict_as_json(self):
        q = JobQueue()
        result = q._serialize_job_data({"config": {"a": 1}})
        assert result["config"] == '{"a": 1}'

    def test_serialize_list_as_json(self):
        q = JobQueue()
        result = q._serialize_job_data({"args": ["--lr", "0.01"]})
        assert result["args"] == '["--lr", "0.01"]'

    def test_deserialize_progress_as_float(self):
        q = JobQueue()
        result = q._deserialize_job_data({"progress": "0.75"})
        assert isinstance(result["progress"], float)
        assert result["progress"] == 0.75

    def test_deserialize_model_config_as_dict(self):
        q = JobQueue()
        raw = {"model_config": '{"type": "linear"}'}
        result = q._deserialize_job_data(raw)
        assert result["model_config"] == {"type": "linear"}

    def test_deserialize_created_at_as_datetime(self):
        q = JobQueue()
        now = datetime.utcnow()
        raw = {"created_at": now.isoformat()}
        result = q._deserialize_job_data(raw)
        assert isinstance(result["created_at"], datetime)
