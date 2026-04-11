"""
Shared pytest fixtures for PyTorchRunner tests.
"""
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def mock_os_path(tmp_path):
    """Create real temp files/dirs so path validation in script_api passes."""
    script_file = tmp_path / "test_script.py"
    script_file.write_text('print("hello from test")\n')
    return {
        "cwd": str(tmp_path),
        "script": "test_script.py",
        "script_path": str(script_file),
    }


@pytest.fixture
def valid_script_request(mock_os_path):
    """A valid ScriptExecutionRequest payload."""
    return {
        "script": mock_os_path["script"],
        "cwd": mock_os_path["cwd"],
        "args": [],
        "env_vars": {},
        "job_name": "test-job",
    }
