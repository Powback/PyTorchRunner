"""
ExperimentTracker — rich client-side experiment tracking for PyTorchRunner.

Tracks metrics, artifacts, hyperparameters, and images locally, with optional
integration to submit training runs via :class:`~pytorch_runner.runner.JobRunner`.

Usage::

    tracker = ExperimentTracker("my_experiment", output_dir="./experiments")
    tracker.log_params({"lr": 0.01, "epochs": 20})

    for epoch in range(20):
        loss = train_one_epoch()
        tracker.log_metrics({"loss": loss}, step=epoch)

    tracker.log_artifact("checkpoint.pt", metadata={"epoch": 20})
    tracker.save()

    summary = tracker.get_summary()
    print(summary)
"""
import contextlib
import json
import logging
import os
import shutil
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Union

logger = logging.getLogger(__name__)

# Optional: numpy / PIL — imported lazily
_numpy_available: Optional[bool] = None
_pil_available: Optional[bool] = None


def _check_numpy() -> bool:
    global _numpy_available
    if _numpy_available is None:
        try:
            import numpy  # noqa: F401
            _numpy_available = True
        except ImportError:
            _numpy_available = False
    return _numpy_available


def _check_pil() -> bool:
    global _pil_available
    if _pil_available is None:
        try:
            from PIL import Image  # noqa: F401
            _pil_available = True
        except ImportError:
            _pil_available = False
    return _pil_available


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class MetricPoint:
    """A single recorded metric value."""
    key: str
    value: float
    step: Optional[int]
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class ArtifactRecord:
    """Reference to a logged artifact file."""
    name: str
    source_path: str
    stored_path: Optional[str]
    metadata: Dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class ImageRecord:
    """Reference to a logged image."""
    name: str
    stored_path: str
    step: Optional[int]
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


# ---------------------------------------------------------------------------
# ExperimentTracker
# ---------------------------------------------------------------------------

class ExperimentTracker:
    """
    Local experiment tracker with optional PyTorchRunner integration.

    All data is persisted to ``output_dir/<experiment_name>/``.  Within a run
    context (see :meth:`run`) data is further separated by run name.

    Args:
        experiment_name: Name of the experiment.
        output_dir: Root directory for storing experiment data.
                    Defaults to ``./pytorch_runner_experiments``.
        base_url: Optional PyTorchRunner URL for submitting training jobs.
    """

    def __init__(
        self,
        experiment_name: str,
        output_dir: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        self.experiment_name = experiment_name
        self.base_url = base_url
        self._output_dir = Path(output_dir or "./pytorch_runner_experiments") / experiment_name

        # Active run state
        self._run_name: Optional[str] = None
        self._run_dir: Optional[Path] = None

        # In-memory log buffers
        self._params: Dict[str, Any] = {}
        self._metrics: List[MetricPoint] = []
        self._artifacts: List[ArtifactRecord] = []
        self._images: List[ImageRecord] = []
        self._tags: Dict[str, str] = {}
        self._start_time: Optional[float] = None
        self._end_time: Optional[float] = None

        self._output_dir.mkdir(parents=True, exist_ok=True)

    # ---- run context --------------------------------------------------

    @contextmanager
    def run(self, run_name: Optional[str] = None) -> Iterator["ExperimentTracker"]:
        """
        Context manager for a named run within the experiment.

        Each run gets its own sub-directory and resets in-memory buffers::

            with tracker.run("baseline") as t:
                t.log_params({"lr": 0.01})
                t.log_metrics({"loss": 0.5})
            # data is auto-saved on exit
        """
        self.start_run(run_name)
        try:
            yield self
        finally:
            self.end_run()

    def start_run(self, run_name: Optional[str] = None) -> None:
        """Start a new run, resetting in-memory buffers."""
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        self._run_name = run_name or f"run_{ts}"
        self._run_dir = self._output_dir / self._run_name
        self._run_dir.mkdir(parents=True, exist_ok=True)

        # Reset buffers
        self._params = {}
        self._metrics = []
        self._artifacts = []
        self._images = []
        self._tags = {}
        self._start_time = time.time()
        self._end_time = None

        logger.info("Started run %r in experiment %r", self._run_name, self.experiment_name)

    def end_run(self) -> None:
        """End the active run and save all data to disk."""
        self._end_time = time.time()
        self.save()
        logger.info("Ended run %r (%.1fs)", self._run_name, self._end_time - (self._start_time or 0))

    # ---- logging API --------------------------------------------------

    def log_params(self, params: Dict[str, Any]) -> None:
        """
        Log hyperparameters or configuration values.

        Args:
            params: Key-value pairs to record (e.g. ``{"lr": 0.01, "batch_size": 32}``).
        """
        self._params.update(params)
        logger.debug("log_params: %s", params)

    def log_metrics(self, metrics: Dict[str, float], step: Optional[int] = None) -> None:
        """
        Log one or more scalar metric values.

        Args:
            metrics: Dictionary of metric name → value.
            step: Optional step/epoch number for the metrics.

        Example::

            tracker.log_metrics({"loss": 0.5, "accuracy": 0.85}, step=epoch)
        """
        for key, value in metrics.items():
            self._metrics.append(MetricPoint(key=key, value=float(value), step=step))
        logger.debug("log_metrics step=%s: %s", step, metrics)

    def log_artifact(self, file_path: str, name: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> None:
        """
        Record an artifact file (checkpoint, config, etc.).

        The file is copied into the run directory for persistence.

        Args:
            file_path: Path to the artifact file.
            name: Logical name (defaults to the filename).
            metadata: Optional key-value metadata (e.g. ``{"epoch": 10}``).

        Example::

            tracker.log_artifact("checkpoint.pt", metadata={"epoch": 10})
        """
        src = Path(file_path)
        artifact_name = name or src.name
        metadata = metadata or {}

        stored_path = None
        if src.exists():
            dest_dir = self._ensure_run_dir() / "artifacts"
            dest_dir.mkdir(exist_ok=True)
            dest = dest_dir / artifact_name
            shutil.copy2(src, dest)
            stored_path = str(dest.relative_to(self._output_dir))
            logger.debug("Copied artifact %s → %s", src, dest)
        else:
            logger.warning("Artifact file not found (recorded as reference only): %s", file_path)

        self._artifacts.append(ArtifactRecord(
            name=artifact_name,
            source_path=str(file_path),
            stored_path=stored_path,
            metadata=metadata,
        ))

    def log_image(
        self,
        image: Any,
        name: str,
        step: Optional[int] = None,
        format: str = "PNG",
    ) -> None:
        """
        Log an image (numpy array or PIL Image).

        Requires either ``numpy`` or ``Pillow`` to be installed.

        Args:
            image: Image data — numpy array (H×W×C or H×W) or PIL Image.
            name: Logical name for the image (used as filename, without extension).
            step: Optional step number.
            format: Image format for saving (default: ``"PNG"``).

        Example::

            tracker.log_image(output_array, "sample_output", step=10)
        """
        img_dir = self._ensure_run_dir() / "images"
        img_dir.mkdir(exist_ok=True)

        step_suffix = f"_step{step}" if step is not None else ""
        filename = f"{name}{step_suffix}.{format.lower()}"
        dest = img_dir / filename

        # Try PIL first
        if _check_pil():
            from PIL import Image as PILImage  # type: ignore
            if not isinstance(image, PILImage.Image):
                if _check_numpy():
                    import numpy as np  # type: ignore
                    arr = np.asarray(image)
                    if arr.dtype != np.uint8:
                        arr = (arr * 255).clip(0, 255).astype(np.uint8)
                    image = PILImage.fromarray(arr)
                else:
                    raise ImportError("numpy or PIL required to log images")
            image.save(str(dest), format=format)
        elif _check_numpy():
            import numpy as np  # type: ignore
            arr = np.asarray(image)
            # Save as raw npy if PIL unavailable
            dest = img_dir / f"{name}{step_suffix}.npy"
            np.save(str(dest), arr)
            logger.warning("PIL not available — image saved as .npy: %s", dest)
        else:
            raise ImportError("Install 'Pillow' or 'numpy' to log images: pip install Pillow")

        self._images.append(ImageRecord(
            name=name,
            stored_path=str(dest.relative_to(self._output_dir)),
            step=step,
        ))
        logger.debug("Logged image %s → %s", name, dest)

    def set_tag(self, key: str, value: str) -> None:
        """Set a string tag on the current run."""
        self._tags[key] = value

    # ---- summary / persistence ----------------------------------------

    def get_summary(self) -> Dict[str, Any]:
        """
        Return a summary dict of the current run state.

        Includes last recorded value per metric, params, artifact names, and tags.
        """
        # Latest value per metric
        latest_metrics: Dict[str, float] = {}
        for mp in self._metrics:
            latest_metrics[mp.key] = mp.value

        return {
            "experiment": self.experiment_name,
            "run": self._run_name,
            "params": self._params,
            "metrics": latest_metrics,
            "metric_history": [asdict(m) for m in self._metrics],
            "artifacts": [a.name for a in self._artifacts],
            "images": [i.name for i in self._images],
            "tags": self._tags,
            "start_time": datetime.fromtimestamp(self._start_time, timezone.utc).isoformat() if self._start_time else None,
            "end_time": datetime.fromtimestamp(self._end_time, timezone.utc).isoformat() if self._end_time else None,
            "duration_s": round(self._end_time - self._start_time, 3)
                if (self._start_time and self._end_time) else None,
        }

    def save(self, path: Optional[str] = None) -> Path:
        """
        Persist the current run data to a JSON file.

        Args:
            path: Override the output file path.

        Returns:
            Path to the written file.
        """
        summary = self.get_summary()
        out = Path(path) if path else self._ensure_run_dir() / "experiment.json"
        out.write_text(json.dumps(summary, indent=2))
        logger.info("Saved experiment data to %s", out)
        return out

    def load(self, path: str) -> Dict[str, Any]:
        """
        Load a previously saved experiment JSON file.

        Returns:
            The parsed experiment data dict.
        """
        data = json.loads(Path(path).read_text())
        self._params = data.get("params", {})
        self._tags = data.get("tags", {})
        self._metrics = [
            MetricPoint(**m) for m in data.get("metric_history", [])
        ]
        return data

    # ---- metric helpers -----------------------------------------------

    def get_metric_history(self, key: str) -> List[MetricPoint]:
        """Return all recorded values for a given metric key."""
        return [m for m in self._metrics if m.key == key]

    def get_best_metric(self, key: str, mode: str = "min") -> Optional[float]:
        """
        Return the best (min or max) recorded value for a metric.

        Args:
            key: Metric name.
            mode: ``"min"`` or ``"max"``.
        """
        values = [m.value for m in self._metrics if m.key == key]
        if not values:
            return None
        return min(values) if mode == "min" else max(values)

    # ---- internal helpers --------------------------------------------

    def _ensure_run_dir(self) -> Path:
        """Return active run directory, defaulting to the experiment root."""
        if self._run_dir:
            return self._run_dir
        # No active run — use a default directory
        default = self._output_dir / "default"
        default.mkdir(parents=True, exist_ok=True)
        self._run_dir = default
        return default

    # ---- repr ---------------------------------------------------------

    def __repr__(self) -> str:
        run = f" run={self._run_name!r}" if self._run_name else ""
        return f"<ExperimentTracker experiment={self.experiment_name!r}{run}>"
