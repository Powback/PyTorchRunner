"""
Shared data models for PyTorchRunner SDK.
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class JobStatus:
    """Current state of a submitted job."""
    job_id: str
    status: str  # queued | running | completed | failed | cancelled
    script: str
    args: List[str]
    cwd: str
    progress: float
    created_at: str
    updated_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    exit_code: Optional[int] = None
    stdout_preview: str = ""
    stderr_preview: str = ""
    stdout_full: str = ""
    stderr_full: str = ""
    stdout_line_count: int = 0
    stderr_line_count: int = 0
    error: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "JobStatus":
        known = {f for f in cls.__dataclass_fields__}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)

    @property
    def is_terminal(self) -> bool:
        return self.status in ("completed", "failed", "cancelled")

    @property
    def succeeded(self) -> bool:
        return self.status == "completed" and (self.exit_code is None or self.exit_code == 0)


@dataclass
class JobResult:
    """Final result of a completed job."""
    job_id: str
    status: str
    exit_code: Optional[int]
    stdout: str
    stderr: str
    duration: float  # seconds
    error: Optional[str] = None

    @property
    def succeeded(self) -> bool:
        return self.status == "completed" and (self.exit_code is None or self.exit_code == 0)

    def raise_on_failure(self) -> None:
        """Raise JobFailedError if the job did not succeed."""
        from .exceptions import JobFailedError
        if not self.succeeded:
            raise JobFailedError(self.job_id, self.exit_code or -1, self.stderr)


@dataclass
class OutputLine:
    """A single line of streamed job output."""
    type: str     # "stdout" | "stderr" | "status" | "done"
    line: str = ""
    line_no: int = 0
    status: Optional[str] = None
    exit_code: Optional[int] = None


@dataclass
class HealthStatus:
    """Service health snapshot."""
    service: str
    status: str
    mps_available: bool
    queue_size: int
    active_jobs: int
    api_version: str = ""

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "HealthStatus":
        known = {f for f in cls.__dataclass_fields__}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)
