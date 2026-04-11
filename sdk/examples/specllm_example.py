"""
SpecLLM integration example.

Shows how SpecLLM (or any Docker agent) submits training jobs to PyTorchRunner.
The namespace parameter prefixes all job names for easy filtering on the dashboard.

Usage:
    # From within a Docker container:
    export PYTORCH_RUNNER_URL=http://pytorch-api.pow
    python specllm_example.py
"""
import asyncio
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pytorch_runner import JobRunner, JobFailedError


PYTORCH_RUNNER_URL = os.getenv("PYTORCH_RUNNER_URL", "http://pytorch-api.pow")
WORKSPACE = os.getenv("SPECLLM_WORKSPACE", "/workspace/specllm")


# ---------------------------------------------------------------------------
# Synchronous usage (simplest)
# ---------------------------------------------------------------------------

def run_rssm_benchmark():
    """Submit an RSSM benchmark and block until complete."""
    runner = JobRunner(namespace="specllm", base_url=PYTORCH_RUNNER_URL)

    print("Submitting RSSM benchmark...")
    job = runner.run_script(
        "run_rssm_benchmark.py",
        args=["--model", "rssm-v2", "--steps", "1000"],
        cwd=WORKSPACE,
        env={"PYTORCH_ENABLE_MPS_FALLBACK": "1"},
    )
    print(f"Job ID: {job.job_id}")

    # Block until done — raise immediately if the script exits non-zero
    try:
        result = job.wait(poll_interval=5.0, raise_on_failure=True)
    except JobFailedError as e:
        print(f"Benchmark failed:\n{e}")
        return None

    print(f"Benchmark complete in {result.duration:.1f}s")
    return result


def run_training_pipeline():
    """Run a multi-step training pipeline sequentially."""
    runner = JobRunner(namespace="specllm", base_url=PYTORCH_RUNNER_URL)

    steps = [
        ("preprocess.py", ["--dataset", "train"]),
        ("train.py",      ["--lr", "1e-4", "--epochs", "50"]),
        ("evaluate.py",   ["--split", "test"]),
    ]

    results = []
    for script, args in steps:
        print(f"\n→ Running {script}...")
        job = runner.run_script(script, args=args, cwd=WORKSPACE)
        result = job.wait(raise_on_failure=True)
        print(f"  Completed in {result.duration:.1f}s")
        results.append(result)

    return results


# ---------------------------------------------------------------------------
# Async usage (non-blocking — fits async agent loops)
# ---------------------------------------------------------------------------

async def run_parallel_experiments():
    """Run multiple hyperparameter configurations in parallel."""
    runner = JobRunner(namespace="specllm", base_url=PYTORCH_RUNNER_URL)

    configs = [
        ["--lr", "1e-3", "--tag", "lr-high"],
        ["--lr", "1e-4", "--tag", "lr-mid"],
        ["--lr", "1e-5", "--tag", "lr-low"],
    ]

    # Submit all jobs
    jobs = [
        await runner.run_script_async("train.py", args=args, cwd=WORKSPACE)
        for args in configs
    ]
    print(f"Submitted {len(jobs)} parallel jobs")

    # Wait for all concurrently
    results = await asyncio.gather(*[j.wait_async(raise_on_failure=False) for j in jobs])
    for job, result in zip(jobs, results):
        status = "✓" if result.succeeded else "✗"
        print(f"  {status} {job.job_id[:8]} — {result.status} ({result.duration:.1f}s)")

    return results


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    result = run_rssm_benchmark()
    if result:
        print("\nStdout output:")
        print(result.stdout[-2000:] if len(result.stdout) > 2000 else result.stdout)
