"""
Storage Data Models for PyTorchRunner

Pydantic models for experiments, metrics, artifacts, and storage health.
"""
from datetime import datetime
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field
import uuid


class ExperimentConfig(BaseModel):
    """Script execution configuration"""
    script: str
    args: List[str] = []
    cwd: str
    env_vars: Dict[str, str] = {}
    job_name: Optional[str] = None


class MetricPoint(BaseModel):
    """A single metric observation"""
    name: str
    value: float
    step: Optional[int] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class TimeSeries(BaseModel):
    """Named time series of metric observations"""
    name: str
    points: List[MetricPoint] = []
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    last_value: Optional[float] = None


class Artifact(BaseModel):
    """A file artifact produced by an experiment"""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    experiment_id: str
    name: str
    artifact_type: str  # checkpoint, image, data, log, output
    file_path: str
    file_size: Optional[int] = None
    metadata: Dict[str, Any] = {}
    version: int = 1
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ModelCheckpoint(BaseModel):
    """A model checkpoint artifact"""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    experiment_id: str
    epoch: int
    step: Optional[int] = None
    file_path: str
    file_size: Optional[int] = None
    metrics: Dict[str, float] = {}
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ResourceUsage(BaseModel):
    """System resource usage snapshot"""
    cpu_percent: Optional[float] = None
    memory_mb: Optional[float] = None
    gpu_memory_mb: Optional[float] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class ExperimentRun(BaseModel):
    """
    Complete experiment run record.
    Maps 1:1 with jobs in the script API.
    """
    id: str
    name: str
    config: ExperimentConfig
    status: str = "queued"  # queued, running, completed, failed, cancelled
    progress: float = 0.0
    exit_code: Optional[int] = None
    error: Optional[str] = None
    tags: List[str] = []
    artifacts: List[Artifact] = []
    checkpoints: List[ModelCheckpoint] = []
    metrics_summary: Dict[str, Any] = {}  # last known values per metric
    stdout_preview: str = ""
    stderr_preview: str = ""
    stdout_path: Optional[str] = None  # path to persisted log file
    stderr_path: Optional[str] = None
    relationships: List[str] = []  # related experiment IDs
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ExperimentListItem(BaseModel):
    """Lightweight experiment summary for list views"""
    id: str
    name: str
    script: str
    status: str
    progress: float
    exit_code: Optional[int] = None
    tags: List[str] = []
    artifact_count: int = 0
    created_at: datetime
    completed_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None


class StorageHealth(BaseModel):
    """Health status for the storage subsystem"""
    postgres_connected: bool
    redis_connected: bool
    artifact_store_writable: bool
    total_experiments: int = 0
    total_artifacts: int = 0
    artifact_store_bytes: int = 0
    errors: List[str] = []


class CleanupPolicy(BaseModel):
    """Policy for cleaning up old data"""
    max_experiment_age_days: int = 90
    max_artifact_age_days: int = 30
    keep_completed: bool = True
    keep_failed: bool = True
    max_total_artifact_bytes: Optional[int] = None  # None = unlimited
