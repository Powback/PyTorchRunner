# PyTorchRunner Python SDK

Lightweight Python client for submitting jobs to a [PyTorchRunner](https://github.com/matsbak/PyTorchRunner) service and tracking experiments locally.

## Install

```bash
# Core (sync only, requires: requests)
pip install -e .

# With async support
pip install -e ".[async]"

# With image logging
pip install -e ".[images]"

# Everything
pip install -e ".[all]"
```

## Quick start

```python
from pytorch_runner import JobRunner, ExperimentTracker

# Submit a script and wait for results
runner = JobRunner(base_url="http://pytorch-api.pow")
job = runner.run_script("train.py", args=["--lr", "0.01"])
result = job.wait()
print(result.stdout)

# Track metrics and artifacts locally
tracker = ExperimentTracker("my_experiment")
tracker.log_params({"lr": 0.01, "epochs": 20})
tracker.log_metrics({"loss": 0.42, "accuracy": 0.91}, step=1)
tracker.save()
```

---

## JobRunner

REST client wrapping the PyTorchRunner Script Executor API (`POST /run`, `GET /jobs/{id}`, SSE streaming, cancellation).

### Constructor

```python
JobRunner(
    base_url="http://localhost:9100",  # or PYTORCH_RUNNER_URL env var
    namespace=None,      # prefixed to job names, e.g. "specllm"
    api_key=None,        # Bearer token, or PYTORCH_RUNNER_API_KEY
    timeout=30.0,
    max_retries=3,
)
```

### Methods

| Method | Description |
|--------|-------------|
| `run_script(script, args, cwd, env, job_name)` | Submit a script; returns a `Job` handle |
| `await run_script_async(...)` | Async version (requires `aiohttp`) |
| `health()` → `HealthStatus` | Check service health |
| `cancel_all()` → `int` | Cancel all running jobs |

### Environment variables

| Variable | Default |
|----------|---------|
| `PYTORCH_RUNNER_URL` | `http://localhost:9100` |
| `PYTORCH_RUNNER_API_KEY` | *(none)* |
| `PYTORCH_RUNNER_NAMESPACE` | *(none)* |
| `PYTORCH_RUNNER_TIMEOUT` | `30` |
| `PYTORCH_RUNNER_RETRIES` | `3` |

---

## Job

Handle returned by `runner.run_script()`.

```python
job = runner.run_script("train.py", args=["--epochs", "10"], cwd="/workspace")

# Block until done
result = job.wait(poll_interval=2.0, timeout=600, raise_on_failure=True)
print(result.stdout)

# Async
result = await job.wait_async(raise_on_failure=True)

# Stream output line-by-line (SSE)
for line in job.stream():
    if line.type == "stdout":
        print(line.line, end="")
    elif line.type == "done":
        print(f"exit_code={line.exit_code}")
        break

# Async streaming
async for line in job.stream_async():
    print(line.line, end="")

# Cancel
job.cancel()

# Quick status check (makes an API call)
print(job.status)  # "queued" | "running" | "completed" | "failed" | "cancelled"
```

### `JobResult`

Returned by `job.wait()`:

| Field | Type | Description |
|-------|------|-------------|
| `job_id` | `str` | Job identifier |
| `status` | `str` | Terminal status |
| `exit_code` | `int \| None` | Process exit code |
| `stdout` | `str` | Full stdout output |
| `stderr` | `str` | Full stderr output |
| `duration` | `float` | Wall-clock seconds |
| `succeeded` | `bool` | `True` when `status == "completed"` and `exit_code == 0` |

```python
result.raise_on_failure()  # raises JobFailedError if not succeeded
```

---

## ExperimentTracker

Local experiment tracker. Stores data as JSON under `output_dir/<experiment>/`.  
Optional numpy/Pillow support for image logging.

### Constructor

```python
ExperimentTracker(
    experiment_name,
    output_dir="./pytorch_runner_experiments",
    base_url=None,   # optional, for future server sync
)
```

### Logging

```python
tracker.log_params({"lr": 0.01, "batch_size": 64})
tracker.log_metrics({"loss": 0.5, "accuracy": 0.85}, step=epoch)
tracker.log_artifact("checkpoint.pt", metadata={"epoch": 10})
tracker.log_image(numpy_array, "generated_sample", step=5)
tracker.set_tag("dataset", "imagenet")
```

### Run context manager

Each `run()` call resets in-memory buffers and saves on exit:

```python
with tracker.run("baseline") as t:
    t.log_params({"lr": 0.01})
    for epoch in range(20):
        loss = train(...)
        t.log_metrics({"loss": loss}, step=epoch)
    t.log_artifact("model.pt")
# ↑ data auto-saved to output_dir/my_experiment/baseline/experiment.json
```

### Query

```python
tracker.get_summary()          # dict: params, latest metrics, artifact names, tags
tracker.get_metric_history("loss")        # list of MetricPoint
tracker.get_best_metric("loss", mode="min")  # float
```

### Persistence

```python
tracker.save()                 # → output_dir/<exp>/<run>/experiment.json
tracker.save("/path/out.json") # custom path
tracker.load("/path/out.json") # restore params + metrics from file
```

---

## SpecLLM integration

```python
import os
from pytorch_runner import JobRunner

runner = JobRunner(
    namespace="specllm",
    base_url=os.getenv("PYTORCH_RUNNER_URL", "http://pytorch-api.pow"),
)

job = runner.run_script(
    "run_rssm_benchmark.py",
    args=["--model", "rssm-v2", "--steps", "1000"],
    cwd="/workspace/specllm",
)
result = job.wait(raise_on_failure=True)
print(result.stdout)
```

For async agent loops:

```python
job = await runner.run_script_async("train.py", cwd="/workspace/specllm")
result = await job.wait_async(raise_on_failure=True)
```

---

## Error handling

```python
from pytorch_runner import (
    JobFailedError,       # job exited non-zero
    JobNotFoundError,     # job_id not found
    JobTimeoutError,      # wait() exceeded timeout
    ServiceUnavailableError,  # cannot reach PyTorchRunner
    JobSubmissionError,   # API rejected the request (4xx)
)

try:
    result = job.wait(timeout=300, raise_on_failure=True)
except JobTimeoutError:
    job.cancel()
except JobFailedError as e:
    print(f"Failed (exit {e.exit_code}):\n{e.stderr}")
except ServiceUnavailableError:
    print("PyTorchRunner is down")
```

---

## Running tests

```bash
pip install -e ".[dev]"
pytest sdk/tests/ -v
# 46 passed
```
