"""
Unit tests for src/server/script_api.py (v3.0.0)

Uses FastAPI TestClient (synchronous) with:
- Real temp files for path validation
- Mocked job_store (SQLite) so tests never write to disk
- Mocked execute_script so no subprocess is spawned
"""
import json
import pytest
from datetime import datetime
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient

# Patch torch at import time so tests run without a GPU / MPS
import sys
_torch_mock = MagicMock()
_torch_mock.backends.mps.is_available.return_value = False
sys.modules.setdefault("torch", _torch_mock)

# Patch aiosqlite before importing so JobStore never tries to open a real DB
_aiosqlite_mock = MagicMock()
sys.modules.setdefault("aiosqlite", _aiosqlite_mock)


def _make_job_store_mock():
    """Return an AsyncMock that satisfies all JobStore calls."""
    m = AsyncMock()
    m.db_path = ":memory:"
    m.initialize = AsyncMock()
    m.close = AsyncMock()
    m.save_job = AsyncMock()
    m.update_job = AsyncMock()
    m.get_job = AsyncMock(return_value=None)
    m.list_jobs = AsyncMock(return_value=[])
    m.get_running_job_ids_by_namespace = AsyncMock(return_value=[])
    return m


# Patch job_store at module level before importing the app
with patch("src.server.job_store.JobStore", return_value=_make_job_store_mock()):
    from src.server.script_api import app, jobs_db, processes_db, job_store  # noqa: E402


@pytest.fixture(autouse=True)
def reset_state():
    """Reset in-memory stores and re-init mock between tests."""
    jobs_db.clear()
    processes_db.clear()
    job_store.save_job = AsyncMock()
    job_store.update_job = AsyncMock()
    job_store.get_job = AsyncMock(return_value=None)
    job_store.list_jobs = AsyncMock(return_value=[])
    yield
    jobs_db.clear()
    processes_db.clear()


@pytest.fixture
def client():
    # lifespan startup/shutdown calls job_store.initialize/close — already mocked
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture
def mock_os_path(tmp_path):
    script = tmp_path / "train.py"
    script.write_text('print("training")\n')
    return {"cwd": str(tmp_path), "script": "train.py"}


@pytest.fixture
def valid_request(mock_os_path):
    return {
        "script": mock_os_path["script"],
        "cwd": mock_os_path["cwd"],
        "args": [],
        "env_vars": {},
        "job_name": "unit-test-job",
        "namespace": "test-ns",
    }


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------

class TestHealthEndpoint:
    def test_returns_200(self, client):
        assert client.get("/health").status_code == 200

    def test_response_shape(self, client):
        d = client.get("/health").json()
        assert d["status"] == "healthy"
        assert "mps_available" in d
        assert "queue_size" in d
        assert "active_jobs" in d
        assert d["service"] == "PyTorchRunner Script Executor"

    def test_counts_queued_jobs(self, client):
        jobs_db["q1"] = {"status": "queued"}
        assert client.get("/health").json()["queue_size"] == 1

    def test_counts_running_jobs(self, client):
        jobs_db["r1"] = {"status": "running"}
        assert client.get("/health").json()["active_jobs"] == 1


# ---------------------------------------------------------------------------
# POST /run
# ---------------------------------------------------------------------------

class TestRunEndpoint:
    def test_returns_job_id_and_namespace(self, client, valid_request):
        with patch("src.server.script_api.execute_script", new_callable=lambda: lambda *a, **kw: AsyncMock()):
            with patch("asyncio.create_task"):
                resp = client.post("/run", json=valid_request)
        assert resp.status_code == 200
        body = resp.json()
        assert "job_id" in body
        assert body["status"] == "queued"
        assert body["namespace"] == "test-ns"

    def test_job_stored_in_memory(self, client, valid_request):
        with patch("asyncio.create_task"):
            resp = client.post("/run", json=valid_request)
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]
        assert job_id in jobs_db

    def test_job_store_save_called(self, client, valid_request):
        with patch("asyncio.create_task"):
            client.post("/run", json=valid_request)
        job_store.save_job.assert_called_once()

    def test_invalid_cwd_returns_400(self, client):
        resp = client.post("/run", json={
            "script": "run.py",
            "cwd": "/nonexistent/xyz/abc",
        })
        assert resp.status_code == 400
        assert "Working directory does not exist" in resp.json()["detail"]

    def test_missing_script_returns_400(self, client, mock_os_path):
        resp = client.post("/run", json={
            "script": "no_such.py",
            "cwd": mock_os_path["cwd"],
        })
        assert resp.status_code == 400
        assert "Script not found" in resp.json()["detail"]

    def test_missing_cwd_returns_422(self, client):
        assert client.post("/run", json={"script": "run.py"}).status_code == 422

    def test_default_namespace_is_default(self, client, mock_os_path):
        with patch("asyncio.create_task"):
            resp = client.post("/run", json={
                "script": mock_os_path["script"],
                "cwd": mock_os_path["cwd"],
            })
        job_id = resp.json()["job_id"]
        assert jobs_db[job_id]["namespace"] == "default"


# ---------------------------------------------------------------------------
# GET /jobs/{job_id}
# ---------------------------------------------------------------------------

class TestGetJobStatus:
    def _insert_job(self, job_id="j-001", status="queued"):
        jobs_db[job_id] = {
            "job_id": job_id,
            "status": status,
            "script": "train.py",
            "namespace": "test-ns",
            "progress": 0.0,
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        }

    def test_returns_live_job(self, client):
        self._insert_job("j-live")
        resp = client.get("/jobs/j-live")
        assert resp.status_code == 200
        assert resp.json()["job_id"] == "j-live"

    def test_404_for_unknown_job(self, client):
        assert client.get("/jobs/ghost").status_code == 404

    def test_falls_back_to_db_for_historical_job(self, client):
        db_job = {"job_id": "j-hist", "status": "completed", "namespace": "old-ns"}
        job_store.get_job = AsyncMock(return_value=db_job)
        resp = client.get("/jobs/j-hist")
        assert resp.status_code == 200
        assert resp.json()["status"] == "completed"

    def test_strips_internal_sse_fields(self, client):
        self._insert_job("j-strip")
        jobs_db["j-strip"]["_stdout_lines"] = ["line1"]
        jobs_db["j-strip"]["_stderr_lines"] = []
        data = client.get("/jobs/j-strip").json()
        assert "_stdout_lines" not in data
        assert "_stderr_lines" not in data


# ---------------------------------------------------------------------------
# GET /jobs  — list endpoint
# ---------------------------------------------------------------------------

class TestListJobs:
    def test_returns_jobs_list(self, client):
        job_store.list_jobs = AsyncMock(return_value=[])
        resp = client.get("/jobs")
        assert resp.status_code == 200
        assert "jobs" in resp.json()
        assert "total" in resp.json()

    def test_filter_by_namespace(self, client):
        jobs_db["j-ns1"] = {"job_id": "j-ns1", "status": "running", "namespace": "ns1",
                             "created_at": datetime.utcnow().isoformat()}
        jobs_db["j-ns2"] = {"job_id": "j-ns2", "status": "running", "namespace": "ns2",
                             "created_at": datetime.utcnow().isoformat()}
        job_store.list_jobs = AsyncMock(return_value=[])
        resp = client.get("/jobs?namespace=ns1")
        assert resp.status_code == 200
        jobs = resp.json()["jobs"]
        assert all(j["namespace"] == "ns1" for j in jobs)

    def test_filter_by_status(self, client):
        jobs_db["j-running"] = {"job_id": "j-running", "status": "running", "namespace": "x",
                                  "created_at": datetime.utcnow().isoformat()}
        jobs_db["j-done"] = {"job_id": "j-done", "status": "completed", "namespace": "x",
                               "created_at": datetime.utcnow().isoformat()}
        job_store.list_jobs = AsyncMock(return_value=[])
        resp = client.get("/jobs?status=running")
        jobs = resp.json()["jobs"]
        assert all(j["status"] == "running" for j in jobs)


# ---------------------------------------------------------------------------
# POST /jobs/{job_id}/cancel
# ---------------------------------------------------------------------------

class TestCancelJob:
    def _insert_running(self, job_id="j-run"):
        jobs_db[job_id] = {
            "job_id": job_id,
            "status": "running",
            "namespace": "test-ns",
            "progress": 0.3,
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
            "exit_code": None,
            "error": None,
        }
        return job_id

    def test_cancel_running_job(self, client):
        jid = self._insert_running()
        resp = client.post(f"/jobs/{jid}/cancel")
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"
        assert jobs_db[jid]["status"] == "cancelled"

    def test_cancel_sets_exit_code_minus_9(self, client):
        jid = self._insert_running()
        client.post(f"/jobs/{jid}/cancel")
        assert jobs_db[jid]["exit_code"] == -9

    def test_cancel_persists_to_store(self, client):
        jid = self._insert_running()
        client.post(f"/jobs/{jid}/cancel")
        job_store.update_job.assert_called()

    def test_cancel_already_completed(self, client):
        jobs_db["j-done"] = {"job_id": "j-done", "status": "completed",
                              "created_at": datetime.utcnow().isoformat(),
                              "updated_at": datetime.utcnow().isoformat()}
        resp = client.post("/jobs/j-done/cancel")
        assert resp.status_code == 200
        assert resp.json()["status"] == "completed"

    def test_cancel_404_for_unknown(self, client):
        assert client.post("/jobs/ghost/cancel").status_code == 404

    def test_cancel_kills_subprocess(self, client):
        jid = self._insert_running()
        proc = MagicMock()
        proc.returncode = None
        processes_db[jid] = proc
        client.post(f"/jobs/{jid}/cancel")
        proc.kill.assert_called_once()


# ---------------------------------------------------------------------------
# DELETE /jobs/cancel  — namespace-scoped cancellation
# ---------------------------------------------------------------------------

class TestNamespaceCancelEndpoint:
    def test_cancels_only_namespace_jobs(self, client):
        for i, ns in enumerate(["ns-a", "ns-a", "ns-b"]):
            jid = f"ns-job-{i}"
            jobs_db[jid] = {"job_id": jid, "status": "running", "namespace": ns,
                             "created_at": datetime.utcnow().isoformat(),
                             "updated_at": datetime.utcnow().isoformat(),
                             "exit_code": None, "error": None}

        resp = client.request("DELETE", "/jobs/cancel?namespace=ns-a")
        assert resp.status_code == 200
        data = resp.json()
        assert data["namespace"] == "ns-a"
        assert data["cancelled"] == 2

    def test_does_not_cancel_other_namespace(self, client):
        jobs_db["safe-job"] = {"job_id": "safe-job", "status": "running", "namespace": "safe",
                                "created_at": datetime.utcnow().isoformat(),
                                "updated_at": datetime.utcnow().isoformat(),
                                "exit_code": None, "error": None}
        client.request("DELETE", "/jobs/cancel?namespace=other")
        assert jobs_db["safe-job"]["status"] == "running"

    def test_missing_namespace_param_returns_422(self, client):
        assert client.request("DELETE", "/jobs/cancel").status_code == 422


# ---------------------------------------------------------------------------
# POST /jobs/cancel_all  — legacy endpoint
# ---------------------------------------------------------------------------

class TestCancelAllJobs:
    def test_cancels_all_running(self, client):
        for i in range(3):
            jid = f"all-{i}"
            jobs_db[jid] = {"job_id": jid, "status": "running", "namespace": f"ns-{i}",
                             "created_at": datetime.utcnow().isoformat(),
                             "updated_at": datetime.utcnow().isoformat(),
                             "exit_code": None, "error": None}
        resp = client.post("/jobs/cancel_all")
        assert resp.status_code == 200
        assert resp.json()["cancelled"] == 3

    def test_skips_non_running_jobs(self, client):
        jobs_db["done"] = {"job_id": "done", "status": "completed",
                            "created_at": datetime.utcnow().isoformat(),
                            "updated_at": datetime.utcnow().isoformat()}
        assert client.post("/jobs/cancel_all").json()["cancelled"] == 0

    def test_empty_returns_zero(self, client):
        assert client.post("/jobs/cancel_all").json()["cancelled"] == 0


# ---------------------------------------------------------------------------
# GET /jobs/{job_id}/stream  — SSE
# ---------------------------------------------------------------------------

class TestStreamEndpoint:
    def test_404_for_unknown_job(self, client):
        assert client.get("/jobs/ghost/stream").status_code == 404

    def test_returns_event_stream_content_type(self, client):
        jobs_db["s-job"] = {
            "job_id": "s-job",
            "status": "completed",
            "progress": 1.0,
            "exit_code": 0,
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
            "_stdout_lines": [],
            "_stderr_lines": [],
        }
        with client.stream("GET", "/jobs/s-job/stream") as resp:
            assert resp.status_code == 200
            assert "text/event-stream" in resp.headers.get("content-type", "")


# ---------------------------------------------------------------------------
# _sse_event helper
# ---------------------------------------------------------------------------

class TestSseEventHelper:
    def test_format_and_parse(self):
        from src.server.script_api import _sse_event
        raw = _sse_event({"type": "stdout", "line": "hello\n", "line_no": 0})
        assert raw.startswith("data: ")
        assert raw.endswith("\n\n")
        payload = json.loads(raw[len("data: "):-2])
        assert payload["type"] == "stdout"
        assert payload["line_no"] == 0
