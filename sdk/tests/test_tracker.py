"""
Unit tests for ExperimentTracker.
"""
import json
import os
import tempfile
from pathlib import Path

import pytest

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pytorch_runner import ExperimentTracker


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_dir():
    with tempfile.TemporaryDirectory() as d:
        yield d


@pytest.fixture
def tracker(tmp_dir):
    return ExperimentTracker("test_exp", output_dir=tmp_dir)


# ---------------------------------------------------------------------------
# Basic logging
# ---------------------------------------------------------------------------

def test_log_params(tracker):
    tracker.log_params({"lr": 0.01, "batch_size": 32})
    assert tracker._params["lr"] == 0.01
    assert tracker._params["batch_size"] == 32


def test_log_params_merge(tracker):
    tracker.log_params({"a": 1})
    tracker.log_params({"b": 2})
    assert tracker._params == {"a": 1, "b": 2}


def test_log_metrics(tracker):
    tracker.log_metrics({"loss": 0.5, "acc": 0.8}, step=1)
    assert len(tracker._metrics) == 2
    keys = {m.key for m in tracker._metrics}
    assert "loss" in keys
    assert "acc" in keys


def test_log_metrics_step_recorded(tracker):
    tracker.log_metrics({"loss": 0.3}, step=5)
    mp = tracker._metrics[0]
    assert mp.step == 5
    assert mp.value == pytest.approx(0.3)


def test_log_metrics_multiple_steps(tracker):
    for i in range(5):
        tracker.log_metrics({"loss": 1.0 / (i + 1)}, step=i)
    assert len(tracker._metrics) == 5


def test_log_metrics_no_step(tracker):
    tracker.log_metrics({"val_loss": 0.2})
    assert tracker._metrics[0].step is None


def test_set_tag(tracker):
    tracker.set_tag("model", "resnet50")
    assert tracker._tags["model"] == "resnet50"


# ---------------------------------------------------------------------------
# Metric helpers
# ---------------------------------------------------------------------------

def test_get_metric_history(tracker):
    tracker.log_metrics({"loss": 1.0}, step=0)
    tracker.log_metrics({"loss": 0.5}, step=1)
    tracker.log_metrics({"acc": 0.9}, step=1)
    history = tracker.get_metric_history("loss")
    assert len(history) == 2
    assert history[0].value == pytest.approx(1.0)
    assert history[1].value == pytest.approx(0.5)


def test_get_metric_history_empty(tracker):
    assert tracker.get_metric_history("nonexistent") == []


def test_get_best_metric_min(tracker):
    tracker.log_metrics({"loss": 1.0}, step=0)
    tracker.log_metrics({"loss": 0.3}, step=1)
    tracker.log_metrics({"loss": 0.7}, step=2)
    assert tracker.get_best_metric("loss", mode="min") == pytest.approx(0.3)


def test_get_best_metric_max(tracker):
    tracker.log_metrics({"acc": 0.7}, step=0)
    tracker.log_metrics({"acc": 0.9}, step=1)
    assert tracker.get_best_metric("acc", mode="max") == pytest.approx(0.9)


def test_get_best_metric_missing_key(tracker):
    assert tracker.get_best_metric("nonexistent") is None


# ---------------------------------------------------------------------------
# Artifact logging
# ---------------------------------------------------------------------------

def test_log_artifact_copies_file(tracker, tmp_dir):
    # Create a real file to copy
    src = Path(tmp_dir) / "checkpoint.pt"
    src.write_bytes(b"fake checkpoint data")

    tracker.log_artifact(str(src), metadata={"epoch": 10})
    assert len(tracker._artifacts) == 1
    rec = tracker._artifacts[0]
    assert rec.name == "checkpoint.pt"
    assert rec.metadata == {"epoch": 10}
    assert rec.stored_path is not None
    # Verify file was actually copied
    stored = Path(tmp_dir) / "test_exp" / rec.stored_path
    assert stored.exists()


def test_log_artifact_missing_file(tracker):
    # Should not raise — just records as reference-only
    tracker.log_artifact("/nonexistent/path/model.pt", metadata={"epoch": 5})
    assert len(tracker._artifacts) == 1
    assert tracker._artifacts[0].stored_path is None


def test_log_artifact_custom_name(tracker, tmp_dir):
    src = Path(tmp_dir) / "raw.bin"
    src.write_bytes(b"data")
    tracker.log_artifact(str(src), name="model_v2.bin")
    assert tracker._artifacts[0].name == "model_v2.bin"


# ---------------------------------------------------------------------------
# Run context manager
# ---------------------------------------------------------------------------

def test_run_context_manager(tracker):
    with tracker.run("baseline"):
        tracker.log_params({"lr": 0.01})
        tracker.log_metrics({"loss": 0.5}, step=0)

    # After exit, data should be saved
    run_dir = tracker._run_dir
    assert run_dir is not None
    assert (run_dir / "experiment.json").exists()


def test_run_context_resets_state(tracker):
    with tracker.run("run1"):
        tracker.log_metrics({"loss": 1.0})

    with tracker.run("run2"):
        assert len(tracker._metrics) == 0
        tracker.log_metrics({"loss": 0.5})

    assert len(tracker._metrics) == 1


def test_start_end_run_manually(tracker):
    tracker.start_run("manual_run")
    tracker.log_metrics({"loss": 0.3}, step=0)
    tracker.end_run()
    assert tracker._end_time is not None


# ---------------------------------------------------------------------------
# get_summary
# ---------------------------------------------------------------------------

def test_get_summary(tracker):
    tracker.log_params({"lr": 0.01})
    tracker.log_metrics({"loss": 0.5}, step=0)
    tracker.log_metrics({"loss": 0.3}, step=1)
    tracker.set_tag("env", "docker")

    summary = tracker.get_summary()
    assert summary["experiment"] == "test_exp"
    assert summary["params"]["lr"] == 0.01
    assert summary["metrics"]["loss"] == pytest.approx(0.3)  # latest
    assert len(summary["metric_history"]) == 2
    assert summary["tags"]["env"] == "docker"


# ---------------------------------------------------------------------------
# save / load
# ---------------------------------------------------------------------------

def test_save_creates_json(tracker, tmp_dir):
    tracker.log_params({"lr": 0.01})
    tracker.log_metrics({"loss": 0.5}, step=0)
    path = tracker.save()
    assert path.exists()
    data = json.loads(path.read_text())
    assert data["params"]["lr"] == 0.01


def test_save_to_custom_path(tracker, tmp_dir):
    out = os.path.join(tmp_dir, "my_exp.json")
    tracker.log_params({"x": 42})
    tracker.save(path=out)
    data = json.loads(Path(out).read_text())
    assert data["params"]["x"] == 42


def test_load_restores_params_and_metrics(tracker, tmp_dir):
    # Save from one tracker
    tracker.log_params({"lr": 0.01, "epochs": 5})
    tracker.log_metrics({"loss": 0.4}, step=0)
    path = tracker.save(os.path.join(tmp_dir, "exp.json"))

    # Load into a fresh tracker
    tracker2 = ExperimentTracker("test_exp2", output_dir=tmp_dir)
    tracker2.load(str(path))
    assert tracker2._params["lr"] == 0.01
    assert len(tracker2._metrics) == 1
    assert tracker2._metrics[0].value == pytest.approx(0.4)


# ---------------------------------------------------------------------------
# Image logging (numpy required)
# ---------------------------------------------------------------------------

def test_log_image_numpy(tracker):
    np = pytest.importorskip("numpy")
    img = np.zeros((8, 8, 3), dtype=np.uint8)
    tracker.log_image(img, "black_square", step=0)
    assert len(tracker._images) == 1
    rec = tracker._images[0]
    assert rec.name == "black_square"
    assert rec.step == 0


def test_log_image_no_libraries(tracker, monkeypatch):
    # Patch availability flags
    import pytorch_runner.tracker as tracker_module
    monkeypatch.setattr(tracker_module, "_numpy_available", False)
    monkeypatch.setattr(tracker_module, "_pil_available", False)
    with pytest.raises(ImportError):
        tracker.log_image([[0, 0], [0, 0]], "test")


# ---------------------------------------------------------------------------
# repr
# ---------------------------------------------------------------------------

def test_repr(tracker):
    assert "test_exp" in repr(tracker)
