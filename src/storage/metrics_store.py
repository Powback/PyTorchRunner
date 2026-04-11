"""
Metrics Store — Redis Streams for Real-time Metrics

Uses Redis Streams (XADD/XREAD) to buffer metrics and output lines
during experiment execution. Data is queryable in real-time and
retained for a configurable TTL after job completion.

Stream key schema:
    pytorchrunner:metrics:{experiment_id}      — training metrics
    pytorchrunner:stdout:{experiment_id}       — stdout line buffer
    pytorchrunner:stderr:{experiment_id}       — stderr line buffer
"""
import json
import logging
import os
from datetime import datetime
from typing import Dict, Any, List, Optional, AsyncGenerator

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

# Default TTL for streams after job completion (24 hours)
STREAM_TTL_SECONDS = int(os.environ.get("METRICS_STREAM_TTL", 86400))
# Maximum stream length before automatic trimming
MAX_STREAM_LEN = 10_000


class MetricsStore:
    """
    Redis Streams backed store for real-time metrics and output buffering.

    Gracefully no-ops when Redis is unavailable.
    """

    def __init__(self, redis_url: Optional[str] = None):
        self.redis_url = redis_url or os.environ.get(
            "REDIS_URL", "redis://redis:6379"
        )
        self._redis: Optional[aioredis.Redis] = None

    @property
    def is_connected(self) -> bool:
        return self._redis is not None

    async def connect(self):
        """Connect to Redis."""
        try:
            self._redis = aioredis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
                socket_connect_timeout=5,
            )
            await self._redis.ping()
            logger.info("MetricsStore connected to Redis")
        except Exception as e:
            logger.warning(f"MetricsStore: Redis unavailable — metrics streaming disabled: {e}")
            self._redis = None

    async def disconnect(self):
        if self._redis:
            await self._redis.close()
            self._redis = None

    # ---- Metrics --------------------------------------------------------

    async def record_metric(
        self,
        experiment_id: str,
        name: str,
        value: float,
        step: Optional[int] = None,
    ):
        """Append a metric point to the experiment's metrics stream."""
        if not self._redis:
            return
        stream_key = f"pytorchrunner:metrics:{experiment_id}"
        entry = {
            "name": name,
            "value": str(value),
            "step": str(step) if step is not None else "",
            "ts": datetime.utcnow().isoformat(),
        }
        try:
            await self._redis.xadd(stream_key, entry, maxlen=MAX_STREAM_LEN, approximate=True)
        except Exception as e:
            logger.debug(f"Failed to record metric to stream: {e}")

    async def record_metrics_dict(
        self,
        experiment_id: str,
        metrics: Dict[str, Any],
        step: Optional[int] = None,
    ):
        """Append multiple metrics in a single stream entry."""
        if not self._redis or not metrics:
            return
        stream_key = f"pytorchrunner:metrics:{experiment_id}"
        entry = {
            "metrics_json": json.dumps({
                k: v for k, v in metrics.items()
                if isinstance(v, (int, float))
            }),
            "step": str(step) if step is not None else "",
            "ts": datetime.utcnow().isoformat(),
        }
        try:
            await self._redis.xadd(stream_key, entry, maxlen=MAX_STREAM_LEN, approximate=True)
        except Exception as e:
            logger.debug(f"Failed to record metrics dict to stream: {e}")

    async def get_metrics_stream(
        self,
        experiment_id: str,
        since_id: str = "0",
        count: int = 1000,
    ) -> List[Dict[str, Any]]:
        """
        Read metric entries from the stream.

        Args:
            experiment_id: Experiment to read from
            since_id: Redis stream ID to read from (exclusive), '0' = all
            count: Max entries to return

        Returns list of dicts with {id, name/metrics_json, value, step, ts}
        """
        if not self._redis:
            return []
        stream_key = f"pytorchrunner:metrics:{experiment_id}"
        try:
            entries = await self._redis.xrange(stream_key, min=since_id, count=count)
            result = []
            for entry_id, data in entries:
                item = {"id": entry_id, **data}
                # Parse batch metrics if present
                if "metrics_json" in data:
                    try:
                        item["metrics"] = json.loads(data["metrics_json"])
                    except json.JSONDecodeError:
                        pass
                if "value" in data:
                    try:
                        item["value"] = float(data["value"])
                    except ValueError:
                        pass
                if "step" in data and data["step"]:
                    try:
                        item["step"] = int(data["step"])
                    except ValueError:
                        pass
                result.append(item)
            return result
        except Exception as e:
            logger.debug(f"Failed to read metrics stream: {e}")
            return []

    # ---- Output buffering -----------------------------------------------

    async def append_stdout(self, experiment_id: str, line: str):
        """Append a stdout line to the experiment's output stream."""
        await self._append_output(experiment_id, "stdout", line)

    async def append_stderr(self, experiment_id: str, line: str):
        """Append a stderr line to the experiment's output stream."""
        await self._append_output(experiment_id, "stderr", line)

    async def _append_output(self, experiment_id: str, stream_type: str, line: str):
        """Append a line to an output stream."""
        if not self._redis:
            return
        stream_key = f"pytorchrunner:{stream_type}:{experiment_id}"
        try:
            await self._redis.xadd(
                stream_key,
                {"line": line, "ts": datetime.utcnow().isoformat()},
                maxlen=MAX_STREAM_LEN,
                approximate=True,
            )
        except Exception as e:
            logger.debug(f"Failed to append {stream_type} line: {e}")

    async def get_output_stream(
        self,
        experiment_id: str,
        stream_type: str,  # stdout or stderr
        since_id: str = "0",
        count: int = 500,
    ) -> List[Dict[str, Any]]:
        """Read output lines from a Redis stream."""
        if not self._redis:
            return []
        stream_key = f"pytorchrunner:{stream_type}:{experiment_id}"
        try:
            entries = await self._redis.xrange(stream_key, min=since_id, count=count)
            return [{"id": entry_id, **data} for entry_id, data in entries]
        except Exception as e:
            logger.debug(f"Failed to read {stream_type} stream: {e}")
            return []

    # ---- Lifecycle management ------------------------------------------

    async def set_experiment_ttl(self, experiment_id: str):
        """
        Set TTL on all streams for a completed experiment.
        Streams expire automatically after STREAM_TTL_SECONDS.
        """
        if not self._redis:
            return
        stream_keys = [
            f"pytorchrunner:metrics:{experiment_id}",
            f"pytorchrunner:stdout:{experiment_id}",
            f"pytorchrunner:stderr:{experiment_id}",
        ]
        for key in stream_keys:
            try:
                await self._redis.expire(key, STREAM_TTL_SECONDS)
            except Exception as e:
                logger.debug(f"Failed to set TTL on {key}: {e}")

    async def delete_experiment_streams(self, experiment_id: str):
        """Immediately delete all streams for an experiment."""
        if not self._redis:
            return
        stream_keys = [
            f"pytorchrunner:metrics:{experiment_id}",
            f"pytorchrunner:stdout:{experiment_id}",
            f"pytorchrunner:stderr:{experiment_id}",
        ]
        try:
            await self._redis.delete(*stream_keys)
        except Exception as e:
            logger.debug(f"Failed to delete streams: {e}")

    async def get_stream_info(self, experiment_id: str) -> Dict[str, Any]:
        """Get info about the streams for an experiment."""
        if not self._redis:
            return {}
        info = {}
        for stream_type in ("metrics", "stdout", "stderr"):
            key = f"pytorchrunner:{stream_type}:{experiment_id}"
            try:
                length = await self._redis.xlen(key)
                ttl = await self._redis.ttl(key)
                info[stream_type] = {"length": length, "ttl_seconds": ttl}
            except Exception:
                info[stream_type] = {"length": 0, "ttl_seconds": -1}
        return info
