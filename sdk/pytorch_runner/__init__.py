"""
PyTorchRunner Python SDK
========================

Lightweight client for submitting and monitoring jobs on a PyTorchRunner
service, plus a local experiment tracker for metrics and artifacts.

Quick start::

    from pytorch_runner import JobRunner, ExperimentTracker

    # Submit a script and wait for results
    runner = JobRunner(base_url="http://pytorch-api.pow")
    job = runner.run_script("train.py", args=["--lr", "0.01"])
    result = job.wait()
    print(result.stdout)

    # Track experiment metrics and artifacts
    tracker = ExperimentTracker("my_experiment")
    tracker.log_params({"lr": 0.01, "epochs": 20})
    tracker.log_metrics({"loss": 0.42, "accuracy": 0.91}, step=1)
    tracker.save()
"""

from .config import RunnerConfig
from .exceptions import (
    ConfigurationError,
    JobFailedError,
    JobNotFoundError,
    JobSubmissionError,
    JobTimeoutError,
    PyTorchRunnerError,
    RetryExhaustedError,
    ServiceUnavailableError,
)
from .models import HealthStatus, JobResult, JobStatus, OutputLine
from .runner import Job, JobRunner
from .tracker import ExperimentTracker

__all__ = [
    # Core classes
    "JobRunner",
    "Job",
    "ExperimentTracker",
    # Config
    "RunnerConfig",
    # Models
    "JobStatus",
    "JobResult",
    "OutputLine",
    "HealthStatus",
    # Exceptions
    "PyTorchRunnerError",
    "JobSubmissionError",
    "JobNotFoundError",
    "JobFailedError",
    "JobTimeoutError",
    "ServiceUnavailableError",
    "RetryExhaustedError",
    "ConfigurationError",
]

__version__ = "1.0.0"
