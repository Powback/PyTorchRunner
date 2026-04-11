"""
MetricsLogger — structured metrics channel for PyTorchRunner training scripts.

Writes JSONL records to the path provided by the ``PYTORCHRUNNER_METRICS``
environment variable.  The PyTorchRunner backend tails this file while the
job runs and pushes each record through the SSE stream to the frontend.

2-line opt-in for any training script::

    from pytorch_runner import MetricsLogger
    metrics = MetricsLogger()   # reads env vars automatically

    for step, batch in enumerate(loader):
        loss = train(batch)
        metrics.log(step=step, loss=loss, lr=scheduler.get_last_lr()[0])

No-op when ``PYTORCHRUNNER_METRICS`` is not set, so the same script works
in any environment without extra configuration.
"""

import json
import os
from typing import Any, Optional, Union


class MetricsLogger:
    """
    Write structured training metrics to the PyTorchRunner sidecar file.

    Args:
        job_id: Job identifier.  Auto-discovered from ``PYTORCHRUNNER_JOB_ID``
                if not provided.
        metrics_file: Path to the JSONL metrics file.  Auto-discovered from
                      ``PYTORCHRUNNER_METRICS`` if not provided.

    When neither env var is set the logger is disabled (all calls are no-ops).
    """

    def __init__(
        self,
        job_id: Optional[str] = None,
        metrics_file: Optional[str] = None,
    ) -> None:
        self.job_id: str = job_id or os.environ.get("PYTORCHRUNNER_JOB_ID", "unknown")
        self.metrics_file: Optional[str] = metrics_file or os.environ.get("PYTORCHRUNNER_METRICS")
        self._enabled: bool = bool(self.metrics_file)

    # ── Public API ────────────────────────────────────────────────────────

    def log(self, step: Optional[int] = None, **kwargs: Any) -> None:
        """
        Log metric values for the current step.

        Non-numeric kwargs are silently ignored so you can pass anything
        without wrapping in conditionals.

        Args:
            step: Training step / iteration number.
            **kwargs: Metric names and their scalar values.

        Example::

            metrics.log(step=100, loss=0.312, accuracy=0.876, lr=1e-4)
        """
        if not self._enabled:
            return

        record: dict = {}
        if step is not None:
            record["step"] = int(step)
        for k, v in kwargs.items():
            if isinstance(v, (int, float)):
                record[k] = float(v)
        if not record:
            return

        self._write(record)

    def log_dict(
        self,
        metrics: dict,
        step: Optional[int] = None,
    ) -> None:
        """
        Log a dictionary of metrics.

        Equivalent to ``log(step=step, **metrics)``.

        Args:
            metrics: Dictionary of metric name → scalar value.
            step: Training step / iteration number.

        Example::

            metrics.log_dict({"loss": 0.312, "accuracy": 0.876}, step=100)
        """
        self.log(step=step, **metrics)

    @property
    def enabled(self) -> bool:
        """True when a metrics file path is configured."""
        return self._enabled

    # ── Internal ─────────────────────────────────────────────────────────

    def _write(self, record: dict) -> None:
        assert self.metrics_file is not None
        try:
            with open(self.metrics_file, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\n")
                fh.flush()
        except OSError:
            # Best-effort — never crash the training script
            pass

    def __repr__(self) -> str:
        state = "enabled" if self._enabled else "disabled"
        return f"<MetricsLogger job_id={self.job_id!r} {state}>"
