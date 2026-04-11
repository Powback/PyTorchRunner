"""
Basic PyTorchRunner SDK usage.

Prerequisites:
    pip install pytorch-runner-sdk
    # or from repo root:
    pip install -e sdk/

    # Start PyTorchRunner service:
    python main.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pytorch_runner import JobRunner, JobFailedError, ServiceUnavailableError

BASE_URL = os.getenv("PYTORCH_RUNNER_URL", "http://localhost:9100")


def example_simple_run():
    """Submit a script and wait for results."""
    runner = JobRunner(base_url=BASE_URL)

    # Check service is up first
    try:
        health = runner.health()
        print(f"Service: {health.service} | Status: {health.status} | MPS: {health.mps_available}")
    except ServiceUnavailableError as e:
        print(f"Service unavailable: {e}")
        return

    # Submit script
    job = runner.run_script(
        "train.py",
        args=["--lr", "0.01", "--epochs", "10"],
        cwd="/workspace/my_project",
    )
    print(f"Submitted job: {job.job_id}")

    # Wait for completion
    try:
        result = job.wait(raise_on_failure=True)
        print(f"Status:    {result.status}")
        print(f"Exit code: {result.exit_code}")
        print(f"Duration:  {result.duration:.1f}s")
        print(f"Output:\n{result.stdout}")
    except JobFailedError as e:
        print(f"Job failed: {e}")


def example_streaming():
    """Stream output in real time as the job runs."""
    runner = JobRunner(base_url=BASE_URL)
    job = runner.run_script("train.py", cwd="/workspace/my_project")
    print(f"Streaming output for job {job.job_id}:")

    for line in job.stream():
        if line.type == "stdout":
            print(f"  [stdout] {line.line}", end="")
        elif line.type == "stderr":
            print(f"  [stderr] {line.line}", end="")
        elif line.type == "done":
            print(f"\nJob done — status={line.status} exit_code={line.exit_code}")
            break


def example_context_manager():
    """Use as context manager to ensure session cleanup."""
    with JobRunner(base_url=BASE_URL) as runner:
        job = runner.run_script("eval.py", cwd="/workspace/my_project")
        result = job.wait()
        print(f"Completed: {result.status}")


if __name__ == "__main__":
    example_simple_run()
