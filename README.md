# PyTorchRunner

PyTorchRunner is a small job runner and experiment dashboard for training scripts on Apple Silicon. You queue a Python script through an HTTP API. A worker process on the host machine, where it has MPS/MLX access, claims the job and runs it. The worker streams output and metrics back, and an Astro + React web UI shows jobs, metric charts, TensorBoard scalars and images, and artifacts as they arrive. The repo also contains an older standalone FastAPI "script executor" service and a Python SDK that talks to it.

## Features

- **Job queue over HTTP**: submit a script with `script`, `args`, `cwd`, `env_vars`, `job_name`, `tags` and `namespace`. Jobs are stored in PostgreSQL.
- **Host-side worker** (`mlx_runner.py`):
  - Detects MLX, PyTorch and MPS, registers with the API and sends a heartbeat every 30s.
  - Polls for queued jobs and claims each one atomically, so two runners can't take the same job.
  - Runs the script as a subprocess and reports exit status plus stdout/stderr previews.
- **Metric detection from stdout**: the worker turns JSON lines and lines with two or more numeric `key=value` pairs into metrics. A `[step/total]` pattern sets the step.
- **TensorBoard ingestion**: after a job finishes, the worker reads event files in `runs/`, `logs/`, `tensorboard/` or `tb_logs/` under the job's working directory and uploads scalars and images. Scripts get `JOB_ID` and `PYTORCHRUNNER_JOB_ID` in their environment so they can write to `runs/$JOB_ID`.
- **Artifact collection**: the worker uploads matching files (up to 50 MB each), including:
  - `results/**/*.json`
  - `out/**/*.png|jpg`
  - `renders/**`
  - `output/**`
  - `samples/**`
  - `checkpoints/**/*.pt|pth|safetensors`
- **Web UI**: built with Astro SSR, React, Tailwind and Chart.js, and has these pages:
  - Dashboard (`/`)
  - Job detail (`/experiments/job/[id]`)
  - Analytics (`/analytics`)
  - Hyperparameter analysis (`/analysis`)

  Its components include metric charts, run comparison, a leaderboard, parallel coordinates, a histogram viewer, an image gallery, render playback, an artifact browser and export.
- **Live updates** over a WebSocket (PowSync), with REST fallback in the dashboard.

## Architecture

```
browser ──HTTP/WS──> frontend (Astro SSR: UI + /api/*, WS server on WS_PORT)
                         │
                         ├── PostgreSQL (jobs, metrics, media metadata)
                         └── Redis (optional pub/sub)

mlx_runner.py (on the host, has MPS/MLX) ──HTTP──> frontend /api/*
```

The Astro app reads and writes PostgreSQL directly; there is no separate backend in front of it. It creates its tables (`jobs`, `job_metrics`, `job_metrics_scalars`, `job_media`) on startup.

### HTTP API (served by the frontend)

| Method | Path |
|---|---|
| GET | `/api/health` |
| GET, POST | `/api/jobs` (GET supports `status`, `namespace`, `limit`) |
| GET, PATCH | `/api/jobs/[id]` |
| GET, POST | `/api/jobs/[id]/metrics` |
| GET | `/api/jobs/[id]/metrics/tags` |
| GET, POST | `/api/jobs/[id]/media` |
| GET, DELETE | `/api/jobs/[id]/media/[filename]` |
| GET | `/api/jobs/[id]/artifacts` |
| GET | `/api/experiments`, `/api/experiments/groups`, `/api/experiments/groups/[name]` |
| GET, POST | `/api/runners` |
| ALL | `/api/powsync/[...path]` |

## Requirements

- Docker with Compose (for PostgreSQL, Redis and the frontend).
- Node.js >= 22.12 (if you run the frontend outside Docker).
- Python 3 on the host for the worker. To use MPS you need PyTorch on Apple Silicon. MLX is optional.
- The frontend depends on the **PowSync** library through a local path (`"powsync": "file:../../PowSync"` in `frontend/package.json`). That library is not in this repo, so the frontend won't install or build unless a PowSync checkout sits at that relative path.

## Usage

### 1. Start the stack

`docker-compose.yml` defines four services:

- `postgres`: PostgreSQL 16, bound to `127.0.0.1:5432`.
- `redis`: Redis 7, bound to `127.0.0.1:6379`.
- `frontend`: the Astro app.
- `redis-insight`: optional, only under the `monitoring` profile.

The frontend has no host port mapping. It is meant to sit behind a Traefik reverse proxy on an external Docker network called `traefik`, routed by Host labels. To run it in a different setup, change the labels and network, or add a port mapping for `4321` (HTTP) and `1239` (WebSocket).

```bash
docker network create traefik   # only if it doesn't exist yet
docker compose up -d
docker compose --profile monitoring up -d   # also starts RedisInsight
```

To run the frontend without Docker:

```bash
cd frontend
npm install
npm run dev        # or: npm run build && npm run preview
```

### 2. Start a worker on the host

```bash
pip install -r requirements.txt -r mlx_runner_requirements.txt
PYTORCH_RUNNER_API_URL=http://localhost:4321 python mlx_runner.py
```

### 3. Submit a job

```bash
curl -X POST http://localhost:4321/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"script": "train.py", "cwd": "/path/to/project", "args": ["--epochs", "10"], "namespace": "default"}'
```

The worker runs `python <script> <args...>` in `cwd`; if `cwd` is empty it uses the home directory. It sets `PYTORCH_ENABLE_MPS_FALLBACK=1`, `PYTHONUNBUFFERED=1`, `JOB_ID`, `PYTORCHRUNNER_JOB_ID` and `PYTORCHRUNNER_METRICS` (a per-job JSONL path under `/tmp/pytorchrunner/`), plus any `env_vars` you pass.

## Configuration

**Frontend** (set in `docker-compose.yml`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Enables the Redis pub/sub bridge if set |
| `WS_PORT` | WebSocket server port (default `1239`) |
| `ARTIFACTS_DIR` | Where uploaded media/artifacts are stored (default `/artifacts`) |
| `ALLOWED_ORIGINS` | Optional comma-separated WebSocket origin allowlist |
| `HOST`, `PORT` | Astro Node server bind address and port (`4321`) |

The compose file ships placeholder PostgreSQL credentials. Change them before you expose anything.

**Worker** (`mlx_runner.py`):

| Variable | Purpose |
|---|---|
| `PYTORCH_RUNNER_API_URL` | Base URL of the frontend API. The default is an internal hostname, so set this explicitly. |
| `MLX_RUNNER_NAMESPACE` | Namespace the runner registers under (default `default`) |
| `MLX_RUNNER_ID` | Fixed runner ID (random UUID if unset) |

## Legacy script executor (FastAPI)

`main.py` and `launch.sh` start a standalone FastAPI service (`src/server/script_api.py`) on port 9100. It runs scripts itself, keeps job history in SQLite, and optionally uses PostgreSQL, Redis and a filesystem artifact store. It also offers SSE output streaming, namespace-scoped cancellation and experiment/checkpoint endpoints. Swagger is at `/docs`. `docs/API.md` and the SDK in `sdk/` target this service.

```bash
./launch.sh        # creates venv, installs requirements, starts Redis in Docker if needed
# or
python main.py
```

| Variable | Purpose |
|---|---|
| `PYTORCHRUNNER_DEV=1` | Enables uvicorn hot-reload. This kills running jobs whenever a file changes. |
| `PYTORCHRUNNER_JOB_TIMEOUT` | Per-job wall-clock limit in seconds (default: none) |
| `PYTORCHRUNNER_DB_PATH` | SQLite job store (default `~/.pytorchrunner/jobs.db`) |
| `DATABASE_URL`, `REDIS_URL` | PostgreSQL / Redis for the extended storage layer |
| `ARTIFACT_BASE_PATH` | Artifact directory (default `/app/artifacts`) |
| `METRICS_STREAM_TTL` | Redis metrics stream TTL in seconds (default `86400`) |

### Python SDK

`sdk/` is an installable client package, `pytorch-runner-sdk`. It provides `JobRunner` for submitting jobs and `ExperimentTracker` for tracking metrics and artifacts locally. See `sdk/README.md` and `sdk/examples/`.

```bash
cd sdk && pip install -e ".[all]"
```

## Tests

```bash
pip install -r requirements.txt -r requirements-test.txt
pytest tests/unit -m "not integration and not slow"
cd sdk && pip install -e ".[dev]" && pytest tests
```

GitHub Actions (`.github/workflows/test.yml`) runs:

- the unit tests on Python 3.11 and 3.12;
- an advisory `ruff` lint;
- integration tests on push, against `python main.py` with a Redis service.

## Project structure

```
mlx_runner.py          Host worker: polls the API, runs jobs, uploads metrics/media/artifacts
docker-compose.yml     postgres, redis, frontend, optional redis-insight
frontend/              Astro SSR app: UI, /api/* routes, PowSync WebSocket server
  src/pages/api/       REST endpoints
  src/components/pytorch/  Dashboard, charts, comparison and media components
  src/lib/             DB access, runner registry, PowSync client/server glue
main.py, launch.sh     Start the legacy FastAPI script executor
src/server/            script_api.py (executor), job_store.py (SQLite), api.py
src/storage/           PostgreSQL experiments, Redis metrics, artifact store
src/queue/             Redis job queue
sdk/                   Python client SDK
tests/                 Unit tests for the Python service
docs/API.md            API reference for the legacy executor
```

## Status / notes

This is a personal project and still changing. Some things to know:

- **Two server implementations.** The current design is the Astro frontend plus `mlx_runner.py`. The FastAPI executor, the SDK and `docs/API.md` come from the earlier design. They are still in the repo and CI still tests the FastAPI executor, but the new UI doesn't use them.
- **`src/server/api.py` won't import as-is.** It imports `src.training.mps_trainer`, which isn't in the repo.
- **Runner deregistration fails.** The worker calls `DELETE /api/runners/{id}` on shutdown, but the frontend has no such route. Runners drop out of the registry only after 30s without a heartbeat.
- **Docker build depends on PowSync.** The frontend Docker build expects the PowSync dependency to resolve. Building outside the original development environment hasn't been verified.
