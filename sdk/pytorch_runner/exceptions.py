"""
Custom exceptions for PyTorchRunner SDK.
"""


class PyTorchRunnerError(Exception):
    """Base exception for all SDK errors."""


class JobSubmissionError(PyTorchRunnerError):
    """Raised when a job cannot be submitted to the API."""


class JobNotFoundError(PyTorchRunnerError):
    """Raised when a job ID is not found."""

    def __init__(self, job_id: str):
        super().__init__(f"Job not found: {job_id}")
        self.job_id = job_id


class JobFailedError(PyTorchRunnerError):
    """Raised when a job finishes with a non-zero exit code."""

    def __init__(self, job_id: str, exit_code: int, stderr: str = ""):
        msg = f"Job {job_id} failed with exit code {exit_code}"
        if stderr:
            msg += f"\nstderr: {stderr}"
        super().__init__(msg)
        self.job_id = job_id
        self.exit_code = exit_code
        self.stderr = stderr


class JobTimeoutError(PyTorchRunnerError):
    """Raised when waiting for a job exceeds the timeout."""

    def __init__(self, job_id: str, timeout: float):
        super().__init__(f"Job {job_id} did not complete within {timeout}s")
        self.job_id = job_id
        self.timeout = timeout


class ServiceUnavailableError(PyTorchRunnerError):
    """Raised when the PyTorchRunner service cannot be reached."""


class RetryExhaustedError(PyTorchRunnerError):
    """Raised when all retry attempts fail."""

    def __init__(self, attempts: int, last_error: Exception):
        super().__init__(f"All {attempts} retry attempts failed. Last error: {last_error}")
        self.attempts = attempts
        self.last_error = last_error


class ConfigurationError(PyTorchRunnerError):
    """Raised for invalid SDK configuration."""
