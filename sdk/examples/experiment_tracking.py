"""
Experiment tracking example.

Shows rich experiment tracking: params, metrics, artifacts, and images.

Usage:
    pip install pytorch-runner-sdk[images]
    python experiment_tracking.py
"""
import os
import sys
import tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pytorch_runner import ExperimentTracker


def basic_tracking():
    """Log metrics and params, then inspect the summary."""
    tracker = ExperimentTracker(
        "resnet_ablation",
        output_dir="./experiment_results",
    )

    with tracker.run("baseline_lr1e3") as t:
        t.log_params({"lr": 1e-3, "batch_size": 64, "epochs": 20, "optimizer": "adam"})
        t.set_tag("dataset", "imagenet-subset")
        t.set_tag("model", "resnet50")

        # Simulate training loop
        for epoch in range(20):
            train_loss = 1.0 / (epoch + 1)
            val_loss = train_loss * 1.1
            acc = 1.0 - (train_loss * 0.5)
            t.log_metrics(
                {"train_loss": train_loss, "val_loss": val_loss, "accuracy": acc},
                step=epoch,
            )

        # Log final checkpoint (skipped if file doesn't exist)
        t.log_artifact("/tmp/checkpoint_epoch20.pt", metadata={"epoch": 20, "val_loss": 0.05})

    # After the run exits, data is automatically saved to disk.
    summary = tracker.get_summary()
    print(f"Experiment: {summary['experiment']}")
    print(f"Best loss:  {tracker.get_best_metric('val_loss', mode='min'):.4f}")
    print(f"Best acc:   {tracker.get_best_metric('accuracy', mode='max'):.4f}")
    print(f"Params:     {summary['params']}")
    return tracker


def multi_run_comparison():
    """Compare multiple runs within the same experiment."""
    tracker = ExperimentTracker("lr_sweep", output_dir="./experiment_results")

    lr_values = [1e-2, 1e-3, 1e-4]
    best_results = {}

    for lr in lr_values:
        with tracker.run(f"lr_{lr:.0e}") as t:
            t.log_params({"lr": lr, "epochs": 10})
            for epoch in range(10):
                loss = (lr * 100) / (epoch + 1)
                t.log_metrics({"loss": loss}, step=epoch)
            best_loss = tracker.get_best_metric("loss", mode="min")
            best_results[lr] = best_loss

    print("\nLR sweep results:")
    for lr, loss in sorted(best_results.items(), key=lambda x: x[1]):
        print(f"  lr={lr:.0e}  best_loss={loss:.4f}")

    return best_results


def image_logging_example():
    """Log images (requires numpy and/or Pillow)."""
    try:
        import numpy as np
    except ImportError:
        print("numpy not installed — skipping image logging example")
        return

    tracker = ExperimentTracker("image_gen", output_dir="./experiment_results")

    with tracker.run("sample_images") as t:
        t.log_params({"model": "vae", "latent_dim": 128})

        for step in range(3):
            # Simulate a generated image (8×8 RGB for demo)
            img = (np.random.rand(8, 8, 3) * 255).astype("uint8")
            t.log_image(img, "generated_sample", step=step)
            t.log_metrics({"reconstruction_loss": 0.8 - step * 0.2}, step=step)

    print(f"\nLogged {len(tracker._images)} images")
    summary = tracker.get_summary()
    print(f"Images: {summary['images']}")


def load_existing_experiment():
    """Load a previously saved experiment and inspect it."""
    with tempfile.TemporaryDirectory() as tmp:
        tracker = ExperimentTracker("reload_test", output_dir=tmp)
        with tracker.run("run1") as t:
            t.log_params({"lr": 0.001})
            t.log_metrics({"loss": 0.5}, step=0)
        saved_path = tracker._run_dir / "experiment.json"

        # Load from a fresh tracker
        tracker2 = ExperimentTracker("reloaded", output_dir=tmp)
        data = tracker2.load(str(saved_path))
        print(f"\nLoaded experiment: {data['experiment']}")
        print(f"  Params:  {data['params']}")
        print(f"  Metrics: {data['metrics']}")


if __name__ == "__main__":
    print("=== Basic tracking ===")
    basic_tracking()

    print("\n=== Multi-run comparison ===")
    multi_run_comparison()

    print("\n=== Image logging ===")
    image_logging_example()

    print("\n=== Load/reload ===")
    load_existing_experiment()
