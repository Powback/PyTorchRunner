#!/usr/bin/env python3
"""
MLX Runner — PyTorchRunner worker client

Connects to pytorch.pow/api as a client, polls for queued jobs,
executes them locally with MPS/MLX access, and streams results back.

Architecture:
  pytorch.pow  ←── HTTP ──→  mlx_runner.py (this script, runs on host)
  (Astro API)                (worker, has MPS/MLX access)
"""
import asyncio
import json
import logging
import os
import platform
import socket
import sys
import time
import uuid
import aiohttp
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('mlx_runner')

POLL_INTERVAL = 2          # seconds between job polls
OUTPUT_FLUSH_LINES = 5     # stream output every N lines
METRICS_BATCH_SIZE = 10    # batch metrics before posting
TB_SCAN_DIRS = ['runs', 'logs', 'tensorboard', 'tb_logs']  # dirs to scan for TensorBoard events


class MLXRunner:
    def __init__(self, api_base_url: str, namespace: str, runner_id: Optional[str] = None):
        self.api_base_url = api_base_url.rstrip('/')
        self.namespace = namespace
        self.runner_id = runner_id or str(uuid.uuid4())
        self.hostname = socket.gethostname()
        self.session: Optional[aiohttp.ClientSession] = None
        self.running = False
        self.current_job: Optional[str] = None
        self.capabilities: Dict[str, Any] = {}

    # ─────────────────────────────────────────────────────────────── lifecycle

    async def start(self):
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=30)
        )
        self.running = True

        logger.info("🚀 MLX Runner starting  runner_id=%s", self.runner_id)
        logger.info("📡 API: %s", self.api_base_url)
        logger.info("🏷️  Namespace: %s", self.namespace)

        await self._detect_capabilities()
        await self._wait_for_api()
        await self._register()

        logger.info("✅ Ready — polling for jobs every %ds", POLL_INTERVAL)

        while self.running:
            try:
                await self._poll_and_run()
                await asyncio.sleep(POLL_INTERVAL)
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error("❌ Error in poll loop: %s", e)
                await asyncio.sleep(5)

        await self.stop()

    async def stop(self):
        self.running = False
        if self.session:
            await self.session.close()
        logger.info("🛑 MLX Runner stopped")

    # ──────────────────────────────────────────────────────────── capabilities

    async def _detect_capabilities(self):
        caps: Dict[str, Any] = {
            'platform': platform.platform(),
            'python': sys.version.split()[0],
        }

        try:
            import mlx.core as mx
            caps['mlx'] = True
            caps['mlx_version'] = mx.__version__
            x = mx.array([1, 2, 3])
            mx.eval(mx.sum(x))
            logger.info("✅ MLX %s ready", mx.__version__)
        except ImportError:
            caps['mlx'] = False
            logger.warning("⚠️  MLX not installed")
        except Exception as e:
            caps['mlx'] = False
            logger.warning("⚠️  MLX init failed: %s", e)

        try:
            import torch
            caps['torch'] = torch.__version__
            caps['mps'] = torch.backends.mps.is_available()
            if caps['mps']:
                logger.info("✅ MPS available (torch %s)", torch.__version__)
        except ImportError:
            pass

        self.capabilities = caps

    # ──────────────────────────────────────────────────────────────── API ops

    async def _wait_for_api(self, retries: int = 10):
        for attempt in range(1, retries + 1):
            try:
                async with self.session.get(f"{self.api_base_url}/api/health") as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        logger.info("✅ API connected: %s %s",
                                    data.get('service'), data.get('api_version'))
                        return
            except Exception as e:
                logger.warning("⏳ API not ready (attempt %d/%d): %s", attempt, retries, e)
            await asyncio.sleep(3)
        raise RuntimeError(f"Cannot reach API at {self.api_base_url}/api/health after {retries} attempts")

    async def _register(self):
        try:
            payload = {
                'id': self.runner_id,
                'hostname': self.hostname,
                'namespace': self.namespace,
                'capabilities': self.capabilities,
            }
            async with self.session.post(f"{self.api_base_url}/api/runners", json=payload) as resp:
                if resp.status == 200:
                    logger.info("✅ Registered as runner %s", self.runner_id)
                else:
                    logger.warning("⚠️  Runner registration returned %d", resp.status)
        except Exception as e:
            logger.warning("⚠️  Runner registration failed: %s", e)

    async def _poll_and_run(self):
        if self.current_job:
            return  # busy

        try:
            url = f"{self.api_base_url}/api/jobs?status=queued&namespace={self.namespace}&limit=1"
            async with self.session.get(url) as resp:
                if resp.status != 200:
                    return
                data = await resp.json()
                jobs = data.get('jobs', [])

            if not jobs:
                return

            job = jobs[0]
            job_id = job['job_id']
            logger.info("🎯 Found queued job: %s  script=%s", job_id, job.get('script'))

            await self._execute_job(job_id, job)

        except Exception as e:
            logger.error("❌ Poll error: %s", e)

    # ──────────────────────────────────────────────────────────── job execution

    async def _execute_job(self, job_id: str, job_data: Dict[str, Any]):
        self.current_job = job_id
        try:
            # Atomically claim the job — returns 409 if another runner got it first
            claimed = await self._patch_job(job_id, {
                'status': 'running',
                'runner_id': self.runner_id,
                'progress': 0.05,
            })
            if not claimed:
                logger.info("⏭️  Job %s already claimed, skipping", job_id)
                return

            script   = job_data.get('script', '')
            args     = job_data.get('args') or []
            cwd      = job_data.get('cwd') or str(Path.home())
            env_vars = job_data.get('env_vars') or {}

            # args may be stored as a JSON string if coming from JSONB
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = []

            logger.info("🚀 Executing: %s %s  (cwd=%s)", script, ' '.join(args), cwd)

            cmd = [sys.executable, script] + list(args)
            env = os.environ.copy()
            env.update({'PYTORCH_ENABLE_MPS_FALLBACK': '1', 'PYTHONUNBUFFERED': '1'})
            # Expose job ID so training scripts can write TensorBoard events to the right dir
            env['JOB_ID'] = job_id
            env['PYTORCHRUNNER_JOB_ID'] = job_id
            env.update({k: str(v) for k, v in env_vars.items()})

            start = time.time()
            process = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout_lines, stderr_lines, metrics_buf = await self._stream_output(job_id, process)
            exit_code = await process.wait()
            duration = time.time() - start

            # Flush any remaining metrics
            if metrics_buf:
                await self._post_metrics(job_id, metrics_buf)

            # Read TensorBoard event files after the job finishes
            await self._read_tensorboard_events(job_id, cwd)

            # Final status
            if exit_code == 0:
                logger.info("✅ Job %s completed in %.1fs", job_id, duration)
                await self._patch_job(job_id, {
                    'status': 'completed',
                    'progress': 1.0,
                    'exit_code': 0,
                    'runner_id': self.runner_id,
                    'stdout_full': '\n'.join(stdout_lines),
                    'stderr_full': '\n'.join(stderr_lines),
                    'stdout_preview': '\n'.join(stdout_lines[-50:]),
                    'stderr_preview': '\n'.join(stderr_lines[-20:]),
                    'stdout_line_count': len(stdout_lines),
                    'stderr_line_count': len(stderr_lines),
                })
            else:
                logger.error("❌ Job %s failed (exit=%d) in %.1fs", job_id, exit_code, duration)
                await self._patch_job(job_id, {
                    'status': 'failed',
                    'progress': 1.0,
                    'exit_code': exit_code,
                    'error': f"Process exited with code {exit_code}",
                    'runner_id': self.runner_id,
                    'stdout_full': '\n'.join(stdout_lines),
                    'stderr_full': '\n'.join(stderr_lines),
                    'stdout_preview': '\n'.join(stdout_lines[-50:]),
                    'stderr_preview': '\n'.join(stderr_lines[-20:]),
                    'stdout_line_count': len(stdout_lines),
                    'stderr_line_count': len(stderr_lines),
                })

        except Exception as e:
            logger.error("❌ Job %s execution error: %s", job_id, e)
            await self._patch_job(job_id, {
                'status': 'failed',
                'error': str(e),
                'progress': 1.0,
                'runner_id': self.runner_id,
            })
        finally:
            self.current_job = None

    async def _stream_output(
        self, job_id: str, process: asyncio.subprocess.Process
    ):
        """Collect stdout/stderr, stream previews to API periodically, detect metrics."""
        stdout_lines: List[str] = []
        stderr_lines: List[str] = []
        metrics_buf: List[Dict[str, Any]] = []
        pending_flush = False
        step_counter = [0]

        async def read_stream(stream, lines_list, is_stderr: bool):
            nonlocal pending_flush
            while True:
                raw = await stream.readline()
                if not raw:
                    break

                line = raw.decode('utf-8', errors='replace').rstrip()
                lines_list.append(line)

                if not is_stderr:
                    # Try to detect metrics from stdout
                    m = _detect_metrics(line)
                    if m:
                        step_counter[0] += 1
                        metrics_buf.append({'step': step_counter[0], 'metrics': m})
                        if len(metrics_buf) >= METRICS_BATCH_SIZE:
                            await self._post_metrics(job_id, metrics_buf[:])
                            metrics_buf.clear()

                # Flush preview every OUTPUT_FLUSH_LINES lines
                total = len(stdout_lines) + len(stderr_lines)
                if total % OUTPUT_FLUSH_LINES == 0:
                    await self._patch_job(job_id, {
                        'stdout_preview': '\n'.join(stdout_lines[-50:]),
                        'stderr_preview': '\n'.join(stderr_lines[-20:]),
                        'stdout_line_count': len(stdout_lines),
                        'stderr_line_count': len(stderr_lines),
                        'progress': 0.5,
                        'runner_id': self.runner_id,
                    }, silent=True)

        await asyncio.gather(
            read_stream(process.stdout, stdout_lines, False),
            read_stream(process.stderr, stderr_lines, True),
        )

        return stdout_lines, stderr_lines, metrics_buf

    # ──────────────────────────────────────────────────────────────── helpers

    async def _patch_job(self, job_id: str, data: Dict[str, Any], silent: bool = False) -> bool:
        """PATCH /api/jobs/:id  Returns True on success, False on 409 (already claimed)."""
        try:
            url = f"{self.api_base_url}/api/jobs/{job_id}"
            async with self.session.patch(url, json=data) as resp:
                if resp.status == 409:
                    return False
                if resp.status not in (200, 204) and not silent:
                    logger.warning("PATCH job %s → %d", job_id, resp.status)
                return resp.status in (200, 204)
        except Exception as e:
            if not silent:
                logger.warning("Failed to PATCH job %s: %s", job_id, e)
            return False

    async def _post_metrics(self, job_id: str, points: List[Dict[str, Any]]):
        """Post metrics to the API. Accepts legacy dict format or new scalar format."""
        try:
            url = f"{self.api_base_url}/api/jobs/{job_id}/metrics"
            async with self.session.post(url, json=points) as resp:
                if resp.status not in (200, 201):
                    logger.debug("Metrics POST → %d", resp.status)
        except Exception as e:
            logger.debug("Metrics POST failed: %s", e)

    async def _read_tensorboard_events(self, job_id: str, cwd: str):
        """
        Scan for TensorBoard event files in common directories under `cwd`,
        read scalar summaries via EventAccumulator, and POST them to the API.

        Also checks runs/<job_id>/ directly so scripts that write to
        SummaryWriter(f"runs/{os.environ['JOB_ID']}") are auto-discovered.
        """
        try:
            from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
        except ImportError:
            logger.debug("TensorBoard not installed — skipping event file scan")
            return

        cwd_path = Path(cwd)

        # Candidate directories: named dirs + job-specific subdirs
        candidate_dirs: List[Path] = []
        for dirname in TB_SCAN_DIRS:
            d = cwd_path / dirname
            if d.is_dir():
                candidate_dirs.append(d)
                # Also check job-specific sub-directory
                job_sub = d / job_id
                if job_sub.is_dir():
                    candidate_dirs.append(job_sub)

        if not candidate_dirs:
            logger.debug("No TensorBoard log directories found for job %s in %s", job_id, cwd)
            return

        total_scalars = 0
        for log_dir in candidate_dirs:
            scalars_posted = await self._process_tb_directory(job_id, log_dir)
            total_scalars += scalars_posted

        if total_scalars > 0:
            logger.info("📊 Posted %d TensorBoard scalar points for job %s", total_scalars, job_id)

    async def _process_tb_directory(self, job_id: str, log_dir: Path) -> int:
        """Read one TensorBoard log directory and POST its scalar data. Returns count posted."""
        try:
            from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
        except ImportError:
            return 0

        try:
            ea = EventAccumulator(str(log_dir))
            ea.Reload()
        except Exception as e:
            logger.debug("EventAccumulator failed for %s: %s", log_dir, e)
            return 0

        tags = ea.Tags().get('scalars', [])
        if not tags:
            return 0

        batch: List[Dict[str, Any]] = []
        total = 0
        BATCH = 200  # POST in batches to avoid huge payloads

        for tag in tags:
            try:
                events = ea.Scalars(tag)
            except Exception:
                continue
            for event in events:
                batch.append({
                    'tag': tag,
                    'step': int(event.step),
                    'value': float(event.value),
                    'wall_time': float(event.wall_time),
                })
                total += 1
                if len(batch) >= BATCH:
                    await self._post_metrics(job_id, batch)
                    batch = []

        if batch:
            await self._post_metrics(job_id, batch)

        logger.debug("TensorBoard %s: %d tags, %d scalars", log_dir.name, len(tags), total)
        return total


# ─────────────────────────────────────────────────── metric detection helpers

import re

_METRIC_KW = re.compile(
    r'\b(loss|acc(?:uracy)?|reward|lr|learning[_\s]rate|val[_\s]?loss|val[_\s]?acc|'
    r'train[_\s]?loss|train[_\s]?acc|perplexity|ppl|f1|precision|recall|mae|mse|rmse|'
    r'score|bleu|rouge|kl|entropy|grad[_\s]?norm|throughput)\b',
    re.IGNORECASE,
)
_KV = re.compile(
    r'\b([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:]\s*(-?[0-9]+\.?[0-9]*(?:[eE][+\-]?[0-9]+)?)\b'
)


def _detect_metrics(line: str) -> Optional[Dict[str, float]]:
    line = line.strip()
    if not line:
        return None
    if line.startswith('{') and line.endswith('}'):
        try:
            data = json.loads(line)
            result = {k: float(v) for k, v in data.items() if isinstance(v, (int, float))}
            return result or None
        except Exception:
            pass
    if not _METRIC_KW.search(line):
        return None
    pairs = _KV.findall(line)
    if not pairs:
        return None
    result = {}
    for name, val in pairs:
        try:
            result[name] = float(val)
        except ValueError:
            pass
    return result or None


# ──────────────────────────────────────────────────────────────────────── main

async def main():
    api_url = os.getenv('PYTORCH_RUNNER_API_URL', 'http://pytorch.pow')
    namespace = os.getenv('MLX_RUNNER_NAMESPACE', 'default')
    runner_id = os.getenv('MLX_RUNNER_ID')  # optional, auto-generated if unset

    runner = MLXRunner(api_url, namespace, runner_id)
    try:
        await runner.start()
    except KeyboardInterrupt:
        logger.info("🛑 Shutting down...")
    finally:
        await runner.stop()


if __name__ == '__main__':
    asyncio.run(main())
