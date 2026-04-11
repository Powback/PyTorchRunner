"""
Configuration management for PyTorchRunner SDK.
"""
import os
from dataclasses import dataclass, field
from typing import Optional, Dict


@dataclass
class RunnerConfig:
    """
    Configuration for PyTorchRunner SDK.

    Can be populated from environment variables or explicit arguments.

    Environment variables:
        PYTORCH_RUNNER_URL      - Base URL (default: http://localhost:9100)
        PYTORCH_RUNNER_API_KEY  - Optional API key
        PYTORCH_RUNNER_NAMESPACE- Default namespace prefix for job names
        PYTORCH_RUNNER_TIMEOUT  - HTTP timeout in seconds (default: 30)
        PYTORCH_RUNNER_RETRIES  - Max retries for transient errors (default: 3)
    """
    base_url: str = field(default_factory=lambda: os.getenv("PYTORCH_RUNNER_URL", "http://localhost:9100"))
    api_key: Optional[str] = field(default_factory=lambda: os.getenv("PYTORCH_RUNNER_API_KEY"))
    namespace: Optional[str] = field(default_factory=lambda: os.getenv("PYTORCH_RUNNER_NAMESPACE"))
    timeout: float = field(default_factory=lambda: float(os.getenv("PYTORCH_RUNNER_TIMEOUT", "30")))
    max_retries: int = field(default_factory=lambda: int(os.getenv("PYTORCH_RUNNER_RETRIES", "3")))
    retry_backoff: float = 1.5  # Exponential backoff multiplier
    retry_statuses: tuple = (429, 500, 502, 503, 504)

    @property
    def headers(self) -> Dict[str, str]:
        """Build default request headers."""
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    @classmethod
    def from_env(cls) -> "RunnerConfig":
        """Create config purely from environment variables."""
        return cls()

    def __post_init__(self):
        self.base_url = self.base_url.rstrip("/")
