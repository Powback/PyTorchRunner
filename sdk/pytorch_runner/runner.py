"""
JobRunner — synchronous and asynchronous REST wrapper for PyTorchRunner script execution.

Wraps the Script Executor API:
    POST   /run
    GET    /jobs/{job_id}
    GET    /jobs/{job_id}/stream   (SSE)
    POST   /jobs/{job_id}/cancel
    GET    /health
"""
import asyncio
import json
import logging
import os
import time
from typing import AsyncIterator, Dict, Iterator, List, Optional, Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .config import RunnerConfig
from .exceptions import (
    JobFailedError,
    JobNotFoundError,
    JobSubmissionError,
    JobTimeoutError,
    RetryExhaustedError,
    ServiceUnavailableError,
)
from .models import HealthStatus, JobResult, JobStatus, OutputLine

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _make_session(config: RunnerConfig) -> requests.Session:
    """Build a requests.Session with retry + timeout defaults."""
    session = requests.Session()
    retry = Retry(
        total=config.max_retries,
        backoff_factor=config.retry_backoff,
        status_forcelist=list(config.retry_statuses),
        allowed_methods=["GET", "POST"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update(config.headers)
    return session


def _check_response(resp: requests.Response, job_id: Optional[str] = None) -> None:
    """Raise typed exceptions for non-2xx responses."""
    if resp.status_code == 404:
        raise JobNotFoundError(job_id or "unknown")
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise JobSubmissionError(f"HTTP {resp.status_code}: {detail}")


# ---------------------------------------------------------------------------
# Job handle
# ---------------------------------------------------------------------------

class Job:
    """
    Handle for a submitted job.  Returned by :meth:`JobRunner.run_script`.

    Synchronous usage::

        job = runner.run_script("train.py", args=["--lr", "0.01"])
        result = job.wait()               # blocks until done
        print(result.stdout)

    Async usage::

        job = runner.run_script("train.py")
        result = await job.wait_async()

    Streaming::

        for line in job.stream():
            print(line.line, end="")
    """

    def __init__(self, job_id: str, runner: "JobRunner"):
        self.job_id = job_id
        self._runner = runner

    # ---- status -------------------------------------------------------

    def get_status(self) -> JobStatus:
        """Fetch current job status from the API."""
        return self._runner._get_job_status(self.job_id)

    async def get_status_async(self) -> JobStatus:
        return await self._runner._get_job_status_async(self.job_id)

    @property
    def status(self) -> str:
        """Quick status string — makes a live API call."""
        return self.get_status().status

    # ---- wait ---------------------------------------------------------

    def wait(
        self,
        poll_interval: float = 2.0,
        timeout: Optional[float] = None,
        raise_on_failure: bool = False,
    ) -> JobResult:
        """
        Block until the job reaches a terminal state.

        Args:
            poll_interval: Seconds between status polls.
            timeout: Maximum seconds to wait; raises :class:`JobTimeoutError` if exceeded.
            raise_on_failure: If True, raise :class:`JobFailedError` when job fails.

        Returns:
            :class:`JobResult` with stdout, stderr, exit code and duration.
        """
        start = time.monotonic()
        while True:
            js = self._runner._get_job_status(self.job_id)
            if js.is_terminal:
                result = _job_result_from_status(js, time.monotonic() - start)
                if raise_on_failure:
                    result.raise_on_failure()
                return result

            if timeout is not None and (time.monotonic() - start) >= timeout:
                raise JobTimeoutError(self.job_id, timeout)

            time.sleep(poll_interval)

    async def wait_async(
        self,
        poll_interval: float = 2.0,
        timeout: Optional[float] = None,
        raise_on_failure: bool = False,
    ) -> JobResult:
        """Async version of :meth:`wait`."""
        start = time.monotonic()
        while True:
            js = await self._runner._get_job_status_async(self.job_id)
            if js.is_terminal:
                result = _job_result_from_status(js, time.monotonic() - start)
                if raise_on_failure:
                    result.raise_on_failure()
                return result

            if timeout is not None and (time.monotonic() - start) >= timeout:
                raise JobTimeoutError(self.job_id, timeout)

            await asyncio.sleep(poll_interval)

    # ---- stream -------------------------------------------------------

    def stream(self) -> Iterator[OutputLine]:
        """
        Yield :class:`OutputLine` objects in real time via SSE.

        Example::

            for line in job.stream():
                if line.type == "stdout":
                    print(line.line, end="")
        """
        url = f"{self._runner.config.base_url}/jobs/{self.job_id}/stream"
        with self._runner._session.get(url, stream=True, timeout=None) as resp:
            _check_response(resp, self.job_id)
            for raw in resp.iter_lines():
                if not raw:
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                if raw.startswith("data: "):
                    payload = json.loads(raw[6:])
                    yield _parse_output_line(payload)
                    if payload.get("type") == "done":
                        break

    async def stream_async(self) -> AsyncIterator[OutputLine]:
        """Async generator version of :meth:`stream`.  Requires aiohttp."""
        try:
            import aiohttp
        except ImportError:
            raise ImportError("aiohttp is required for async streaming: pip install aiohttp")

        url = f"{self._runner.config.base_url}/jobs/{self.job_id}/stream"
        headers = self._runner.config.headers
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=None)) as resp:
                async for line in resp.content:
                    raw = line.decode("utf-8").strip()
                    if raw.startswith("data: "):
                        payload = json.loads(raw[6:])
                        yield _parse_output_line(payload)
                        if payload.get("type") == "done":
                            break

    # ---- cancel -------------------------------------------------------

    def cancel(self) -> bool:
        """
        Cancel the job.

        Returns:
            True if the job was running and has been cancelled.
        """
        resp = self._runner._session.post(
            f"{self._runner.config.base_url}/jobs/{self.job_id}/cancel",
            timeout=self._runner.config.timeout,
        )
        _check_response(resp, self.job_id)
        data = resp.json()
        return data.get("status") == "cancelled"

    # ---- repr ---------------------------------------------------------

    def __repr__(self) -> str:
        return f"<Job job_id={self.job_id!r}>"


# ---------------------------------------------------------------------------
# JobRunner
# ---------------------------------------------------------------------------

class JobRunner:
    """
    Synchronous client for submitting and monitoring PyTorchRunner script jobs.

    Instantiate once and reuse — it maintains an HTTP session internally.

    Basic usage::

        runner = JobRunner(base_url="http://pytorch-api.pow")
        job = runner.run_script("train.py", args=["--lr", "0.01"])
        result = job.wait()
        print(result.stdout)

    With namespace (for SpecLLM)::

        runner = JobRunner(namespace="specllm", base_url="http://pytorch-api.pow")
        job = runner.run_script("train.py", cwd="/workspace/specllm")
        result = job.wait(raise_on_failure=True)

    Context manager::

        with JobRunner(base_url="http://pytorch-api.pow") as runner:
            job = runner.run_script("eval.py")
            result = job.wait()
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        namespace: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 3,
        config: Optional[RunnerConfig] = None,
    ):
        if config:
            self.config = config
        else:
            self.config = RunnerConfig(
                base_url=base_url or os.getenv("PYTORCH_RUNNER_URL", "http://localhost:9100"),
                namespace=namespace,
                api_key=api_key,
                timeout=timeout,
                max_retries=max_retries,
            )
        self._session = _make_session(self.config)

    # ---- context manager ----------------------------------------------

    def __enter__(self) -> "JobRunner":
        return self

    def __exit__(self, *_) -> None:
        self._session.close()

    # ---- public API ---------------------------------------------------

    def run_script(
        self,
        script: str,
        args: Optional[List[str]] = None,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        job_name: Optional[str] = None,
    ) -> Job:
        """
        Submit a Python script for execution on PyTorchRunner.

        Args:
            script: Script filename (e.g. ``train.py``).
            args: Command-line arguments passed to the script.
            cwd: Working directory on the PyTorchRunner host.
                 Defaults to ``os.getcwd()``.
            env: Extra environment variables for the script process.
            job_name: Human-readable name; namespace is prepended when set.

        Returns:
            :class:`Job` handle for monitoring, waiting, or streaming output.
        """
        payload = self._build_payload(script, args, cwd, env, job_name)
        try:
            resp = self._session.post(
                f"{self.config.base_url}/run",
                json=payload,
                timeout=self.config.timeout,
            )
        except requests.exceptions.ConnectionError as exc:
            raise ServiceUnavailableError(
                f"Cannot connect to PyTorchRunner at {self.config.base_url}: {exc}"
            )
        _check_response(resp)
        data = resp.json()
        logger.info("Submitted job %s for script %s", data["job_id"], script)
        return Job(data["job_id"], self)

    async def run_script_async(
        self,
        script: str,
        args: Optional[List[str]] = None,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        job_name: Optional[str] = None,
    ) -> Job:
        """Async version of :meth:`run_script`.  Requires aiohttp."""
        try:
            import aiohttp
        except ImportError:
            raise ImportError("aiohttp is required for async job submission: pip install aiohttp")

        payload = self._build_payload(script, args, cwd, env, job_name)
        async with aiohttp.ClientSession(headers=self.config.headers) as session:
            try:
                async with session.post(
                    f"{self.config.base_url}/run",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=self.config.timeout),
                ) as resp:
                    if resp.status >= 400:
                        detail = await resp.text()
                        raise JobSubmissionError(f"HTTP {resp.status}: {detail}")
                    data = await resp.json()
            except aiohttp.ClientConnectionError as exc:
                raise ServiceUnavailableError(
                    f"Cannot connect to PyTorchRunner at {self.config.base_url}: {exc}"
                )
        logger.info("Submitted async job %s for script %s", data["job_id"], script)
        return Job(data["job_id"], self)

    def health(self) -> HealthStatus:
        """Check service health."""
        try:
            resp = self._session.get(
                f"{self.config.base_url}/health",
                timeout=self.config.timeout,
            )
        except requests.exceptions.ConnectionError as exc:
            raise ServiceUnavailableError(str(exc))
        _check_response(resp)
        return HealthStatus.from_dict(resp.json())

    async def health_async(self) -> HealthStatus:
        """Async version of :meth:`health`."""
        try:
            import aiohttp
        except ImportError:
            raise ImportError("aiohttp is required: pip install aiohttp")
        async with aiohttp.ClientSession(headers=self.config.headers) as session:
            async with session.get(
                f"{self.config.base_url}/health",
                timeout=aiohttp.ClientTimeout(total=self.config.timeout),
            ) as resp:
                data = await resp.json()
        return HealthStatus.from_dict(data)

    def cancel_all(self) -> int:
        """Cancel all running jobs.  Returns number of jobs cancelled."""
        resp = self._session.post(
            f"{self.config.base_url}/jobs/cancel_all",
            timeout=self.config.timeout,
        )
        _check_response(resp)
        return resp.json().get("cancelled", 0)

    # ---- internal helpers --------------------------------------------

    def _build_payload(
        self,
        script: str,
        args: Optional[List[str]],
        cwd: Optional[str],
        env: Optional[Dict[str, str]],
        job_name: Optional[str],
    ) -> Dict[str, Any]:
        effective_name = job_name
        if not effective_name and self.config.namespace:
            base = os.path.splitext(os.path.basename(script))[0]
            effective_name = f"{self.config.namespace}/{base}"

        return {
            "script": script,
            "args": args or [],
            "cwd": cwd or os.getcwd(),
            "env_vars": env or {},
            "job_name": effective_name,
        }

    def _get_job_status(self, job_id: str) -> JobStatus:
        try:
            resp = self._session.get(
                f"{self.config.base_url}/jobs/{job_id}",
                timeout=self.config.timeout,
            )
        except requests.exceptions.ConnectionError as exc:
            raise ServiceUnavailableError(str(exc))
        _check_response(resp, job_id)
        return JobStatus.from_dict(resp.json())

    async def _get_job_status_async(self, job_id: str) -> JobStatus:
        try:
            import aiohttp
        except ImportError:
            raise ImportError("aiohttp is required: pip install aiohttp")
        async with aiohttp.ClientSession(headers=self.config.headers) as session:
            async with session.get(
                f"{self.config.base_url}/jobs/{job_id}",
                timeout=aiohttp.ClientTimeout(total=self.config.timeout),
            ) as resp:
                if resp.status == 404:
                    raise JobNotFoundError(job_id)
                data = await resp.json()
        return JobStatus.from_dict(data)

    def __repr__(self) -> str:
        ns = f" namespace={self.config.namespace!r}" if self.config.namespace else ""
        return f"<JobRunner url={self.config.base_url!r}{ns}>"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _job_result_from_status(js: JobStatus, duration: float) -> JobResult:
    return JobResult(
        job_id=js.job_id,
        status=js.status,
        exit_code=js.exit_code,
        stdout=js.stdout_full or js.stdout_preview,
        stderr=js.stderr_full or js.stderr_preview,
        duration=duration,
        error=js.error,
    )


def _parse_output_line(payload: Dict[str, Any]) -> OutputLine:
    return OutputLine(
        type=payload.get("type", ""),
        line=payload.get("line", ""),
        line_no=payload.get("line_no", 0),
        status=payload.get("status"),
        exit_code=payload.get("exit_code"),
    )
