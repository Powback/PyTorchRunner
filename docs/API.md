# PyTorchRunner API Reference

PyTorchRunner exposes a **Script Execution API** on port 9100 (local) / `pytorch-api.pow` (Traefik).  
The interactive Swagger UI is available at `http://localhost:9100/docs`.

---

## Base URL

| Environment | URL |
|-------------|-----|
| Local dev   | `http://localhost:9100` |
| Docker host | `http://host.docker.internal:9100` |
| Local DNS   | `http://pytorch-api.pow` |

---

## Endpoints

### `GET /health`

Returns service health and resource status.

**Response `200 OK`**
```json
{
  "service": "PyTorchRunner Script Executor",
  "status": "healthy",
  "mps_available": true,
  "queue_size": 0,
  "active_jobs": 1,
  "api_version": "3.0.0",
  "persistent_store": "/Users/you/.pytorchrunner/jobs.db"
}
```

---

### `POST /run`

Submit a Python script for execution. The script runs in a background task; output is streamed in real-time via SSE. Jobs are persisted to SQLite so history survives restarts.

**Request body**
```json
{
  "script": "train.py",
  "cwd": "/workspace/my-project",
  "args": ["--epochs", "10", "--lr", "0.001"],
  "env_vars": {
    "WANDB_API_KEY": "...",
    "MY_VAR": "value"
  },
  "job_name": "resnet-ablation-01",
  "namespace": "specllm"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `script` | string | yes | — | Filename relative to `cwd` |
| `cwd` | string | yes | — | Absolute path to working directory (must exist) |
| `args` | string[] | no | `[]` | Command-line arguments |
| `env_vars` | object | no | `{}` | Extra environment variables |
| `job_name` | string | no | auto | Human-readable label |
| `namespace` | string | no | `"default"` | Logical owner for scoped cancellation |

**Response `200 OK`**
```json
{
  "job_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "queued",
  "namespace": "specllm"
}
```

**Errors**
| Code | Reason |
|------|--------|
| `400` | `cwd` does not exist, or script file not found |
| `422` | Missing required fields |

---

### `GET /jobs`

List jobs with optional filtering. Merges live in-memory state with persisted history.

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | — | Filter: `queued \| running \| completed \| failed \| cancelled` |
| `namespace` | string | — | Filter by namespace |
| `limit` | int | 100 | Max results (1–1000) |

**Examples**
```
GET /jobs?namespace=specllm&status=running
GET /jobs?namespace=specllm&limit=50
GET /jobs?status=failed&limit=20
```

**Response `200 OK`**
```json
{
  "jobs": [
    {
      "job_id": "...",
      "namespace": "specllm",
      "status": "completed",
      "script": "train.py",
      "created_at": "2026-04-11T10:00:00",
      ...
    }
  ],
  "total": 1
}
```

---

### `GET /jobs/{job_id}`

Poll status for a single job. Checks live in-memory state first, then falls back to persistent SQLite store for historical jobs.

**Response `200 OK`**
```json
{
  "job_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "namespace": "specllm",
  "script": "train.py",
  "args": ["--epochs", "10"],
  "cwd": "/workspace/my-project",
  "status": "running",
  "progress": 0.1,
  "created_at": "2026-04-11T10:00:00.000000",
  "updated_at": "2026-04-11T10:00:03.123456",
  "started_at": "2026-04-11T10:00:01.000000",
  "completed_at": null,
  "exit_code": null,
  "stdout_preview": "Epoch 1/10 — loss: 0.842\n",
  "stderr_preview": "",
  "stdout_full": "...",
  "stderr_full": "",
  "stdout_line_count": 12,
  "stderr_line_count": 0,
  "error": null
}
```

**Job status values**

| Status | Meaning |
|--------|---------|
| `queued` | Accepted, waiting to start |
| `running` | Subprocess active |
| `completed` | Exit code 0 |
| `failed` | Non-zero exit code |
| `cancelled` | Killed via cancel endpoint |

**Errors**
| Code | Reason |
|------|--------|
| `404` | Job ID not found in memory or DB |

---

### `GET /jobs/{job_id}/stream`

**Server-Sent Events** stream for real-time output. Connect with an `EventSource` or `curl -N`.

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since_line` | int | 0 | Resume streaming from this stdout line number |

**Response headers**
```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

**Event types** (each `data:` field is JSON):

```
data: {"type": "status", "status": "running", "job_id": "..."}

data: {"type": "stdout", "line": "Epoch 1 — loss: 0.84\n", "line_no": 0}

data: {"type": "stderr", "line": "UserWarning: ...\n", "line_no": 0}

data: {"type": "done", "status": "completed", "exit_code": 0, "stdout_lines": 42, "stderr_lines": 0}
```

**JavaScript example**
```javascript
const es = new EventSource(`/jobs/${jobId}/stream`);
es.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if (event.type === 'stdout') console.log(event.line);
  if (event.type === 'done') es.close();
};
```

**Errors**
| Code | Reason |
|------|--------|
| `404` | Job ID not found (must be in current session — historical jobs cannot be streamed) |

---

### `POST /jobs/{job_id}/cancel`

Cancel a running job by sending `SIGKILL` to the subprocess. Status and exit code are persisted.

**Response `200 OK`** — was running, now cancelled:
```json
{"job_id": "...", "status": "cancelled"}
```

**Response `200 OK`** — was not running:
```json
{"job_id": "...", "status": "completed", "message": "Job not running"}
```

**Errors**
| Code | Reason |
|------|--------|
| `404` | Job ID not found |

---

### `DELETE /jobs/cancel`  *(recommended for multi-agent use)*

Cancel all **running** jobs in a given namespace. Safe to call from multiple agents because it only affects the caller's namespace.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `namespace` | yes | Namespace whose running jobs should be cancelled |

**Example**
```
DELETE /jobs/cancel?namespace=specllm
```

**Response `200 OK`**
```json
{
  "namespace": "specllm",
  "cancelled": 2,
  "job_ids": ["abc", "def"]
}
```

---

### `POST /jobs/cancel_all`  *(deprecated)*

Cancel **every** running job regardless of namespace.

> **Deprecated** — prefer `DELETE /jobs/cancel?namespace=<ns>` for safe multi-agent operation. This endpoint is kept for backwards compatibility.

**Response `200 OK`**
```json
{"cancelled": 3, "job_ids": ["abc", "def", "ghi"]}
```

---

## Output buffering

| Field | Limit | Notes |
|-------|-------|-------|
| `stdout_full` / `stderr_full` | 1 MB | In-memory only; oldest bytes dropped when limit reached |
| `stdout_preview` / `stderr_preview` | 2 KB | Last 2 KB of full buffer — persisted to SQLite |
| `stdout_line_count` | unlimited | Count of lines received (for `since_line` resumption) |

---

## Persistence

Jobs are stored in SQLite at `~/.pytorchrunner/jobs.db` (or override with `PYTORCHRUNNER_DB_PATH`).

- **Created** when `POST /run` is called
- **Updated** at status transitions (running → completed/failed/cancelled)
- **Full output** (`stdout_full`/`stderr_full`) is in-memory only — only previews are persisted

---

## Python SDK

```python
from src.client.pytorch_client import PyTorchRunnerClient

async with PyTorchRunnerClient("http://localhost:8000") as client:
    result = await client.train(
        model_config={"type": "linear", "input_size": 784, "output_size": 10},
        training_params={"epochs": 5, "learning_rate": 1e-3, "batch_size": 32},
        data_config={"type": "synthetic", "num_samples": 1000},
        job_name="my-experiment",
        progress_callback=lambda p, m: print(f"Progress: {p:.0%}"),
    )
    print(f"Done: {result.status}")
```

### Docker agent usage

```python
from src.client.pytorch_client import DockerAgentHelper

async with DockerAgentHelper("http://host.docker.internal:8000") as helper:
    result = await helper.replace_local_training(
        model_config={"type": "linear"},
        training_params={"epochs": 10},
        data_config={"type": "synthetic"},
    )
```

---

## Errors

All error responses follow FastAPI's standard format:

```json
{"detail": "Human-readable error message"}
```

---

## Changelog

| Version | Changes |
|---------|---------|
| 3.0.0 | Persistent SQLite store, namespace support, `GET /jobs` list, `DELETE /jobs/cancel` |
| 2.2.0 | `stdout_full`/`stderr_full` (1 MB), `stdout_line_count`, `since_line` SSE resume |
| 2.1.0 | Live SSE streaming, `cancel_all` endpoint |
| 2.0.0 | In-memory job store, async subprocess execution |
