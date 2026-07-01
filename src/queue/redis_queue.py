"""
Redis Job Queue System
[service.queue.1] Redis-based job queue system with progress tracking and result persistence.
"""
import json
import asyncio
from datetime import datetime
from typing import Dict, Any, Optional
import redis.asyncio as aioredis
import logging

logger = logging.getLogger(__name__)


class JobQueue:
    """Redis-based job queue with progress tracking"""

    def __init__(self, redis_url: str = "redis://localhost:6379"):
        self.redis_url = redis_url
        self.redis: Optional[aioredis.Redis] = None
        self.job_prefix = "pytorchrunner:job:"
        self.queue_key = "pytorchrunner:queue"
        self.active_key = "pytorchrunner:active"

    async def connect(self):
        """Connect to Redis"""
        try:
            self.redis = aioredis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True
            )
            # Test connection
            await self.redis.ping()
            logger.info("Connected to Redis")
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            raise

    async def disconnect(self):
        """Disconnect from Redis"""
        if self.redis:
            await self.redis.close()
            logger.info("Disconnected from Redis")

    def get_queue_key(self, gpu_type: Optional[str] = None) -> str:
        """Return the Redis list key for the given GPU type.

        None or "any" → default queue (backward compatible).
        Specific type → pytorchrunner:queue:<gpu_type>
        """
        if gpu_type and gpu_type != "any":
            return f"{self.queue_key}:{gpu_type}"
        return self.queue_key

    async def enqueue_job(self, job_id: str, job_data: Dict[str, Any], gpu_type: Optional[str] = None):
        """
        Enqueue a training job

        Args:
            job_id: Unique job identifier
            job_data: Job configuration and metadata
            gpu_type: Target GPU type ("mps", "3090", "5090", "any", or None for default)
        """
        if not self.redis:
            raise RuntimeError("Redis not connected")

        # Store job data
        job_key = f"{self.job_prefix}{job_id}"

        # Serialize datetime objects
        serializable_data = self._serialize_job_data(job_data)

        await self.redis.hset(job_key, mapping=serializable_data)

        # Add to GPU-specific or default queue
        await self.redis.lpush(self.get_queue_key(gpu_type), job_id)

        logger.info(f"Enqueued job {job_id}")

    async def dequeue_job(self, gpu_type: Optional[str] = None) -> Optional[str]:
        """
        Dequeue next job for processing

        Args:
            gpu_type: Target GPU type to poll, or None for default queue

        Returns:
            Job ID if available, None if queue empty
        """
        if not self.redis:
            raise RuntimeError("Redis not connected")

        # Move job from GPU-specific or default queue to active
        result = await self.redis.brpoplpush(
            self.get_queue_key(gpu_type),
            self.active_key,
            timeout=1  # 1 second timeout
        )

        if result:
            logger.info(f"Dequeued job {result}")

        return result

    async def get_job_status(self, job_id: str) -> Optional[Dict[str, Any]]:
        """
        Get job status and data

        Args:
            job_id: Job identifier

        Returns:
            Job data dictionary or None if not found
        """
        if not self.redis:
            raise RuntimeError("Redis not connected")

        job_key = f"{self.job_prefix}{job_id}"
        job_data = await self.redis.hgetall(job_key)

        if not job_data:
            return None

        return self._deserialize_job_data(job_data)

    async def update_job_status(
        self,
        job_id: str,
        status: str,
        progress: float,
        error: Optional[str] = None
    ):
        """
        Update job status and progress

        Args:
            job_id: Job identifier
            status: New status (queued, running, completed, failed)
            progress: Progress percentage (0.0 - 1.0)
            error: Error message if failed
        """
        if not self.redis:
            raise RuntimeError("Redis not connected")

        job_key = f"{self.job_prefix}{job_id}"

        updates = {
            "status": status,
            "progress": str(progress),
            "updated_at": datetime.utcnow().isoformat()
        }

        if error:
            updates["error"] = error

        await self.redis.hset(job_key, mapping=updates)

        # Remove from active if completed or failed
        if status in ["completed", "failed"]:
            await self.redis.lrem(self.active_key, 1, job_id)

        logger.info(f"Updated job {job_id}: {status} ({progress:.1%})")

    async def update_job_progress(
        self,
        job_id: str,
        progress: float,
        metrics: Dict[str, Any]
    ):
        """
        Update job progress and metrics

        Args:
            job_id: Job identifier
            progress: Progress percentage (0.0 - 1.0)
            metrics: Training metrics
        """
        if not self.redis:
            raise RuntimeError("Redis not connected")

        job_key = f"{self.job_prefix}{job_id}"

        await self.redis.hset(job_key, mapping={
            "progress": str(progress),
            "metrics": json.dumps(metrics),
            "updated_at": datetime.utcnow().isoformat()
        })

    async def get_queue_size(self) -> int:
        """Get number of jobs in queue"""
        if not self.redis:
            return 0
        return await self.redis.llen(self.queue_key)

    async def get_active_job_count(self) -> int:
        """Get number of active jobs"""
        if not self.redis:
            return 0
        return await self.redis.llen(self.active_key)

    async def update_job_fields(self, job_id: str, fields: dict):
        """
        Update arbitrary job fields

        Args:
            job_id: Job identifier
            fields: Dictionary of fields to update
        """
        if not self.redis:
            raise RuntimeError("Redis not connected")

        job_key = f"{self.job_prefix}{job_id}"

        # Serialize the fields
        serialized_fields = {}
        for key, value in fields.items():
            if isinstance(value, (dict, list)):
                serialized_fields[key] = json.dumps(value)
            else:
                serialized_fields[key] = str(value)

        # Update fields
        await self.redis.hset(job_key, mapping=serialized_fields)

    async def cleanup_job(self, job_id: str):
        """
        Clean up job data after completion

        Args:
            job_id: Job identifier to clean up
        """
        if not self.redis:
            raise RuntimeError("Redis not connected")

        job_key = f"{self.job_prefix}{job_id}"

        # Remove job data
        await self.redis.delete(job_key)

        # Remove from active list if present
        await self.redis.lrem(self.active_key, 1, job_id)

        logger.info(f"Cleaned up job {job_id}")

    def _serialize_job_data(self, job_data: Dict[str, Any]) -> Dict[str, str]:
        """Serialize job data for Redis storage"""
        serialized = {}

        for key, value in job_data.items():
            if isinstance(value, datetime):
                serialized[key] = value.isoformat()
            elif isinstance(value, (dict, list)):
                serialized[key] = json.dumps(value)
            else:
                serialized[key] = str(value)

        return serialized

    def _deserialize_job_data(self, job_data: Dict[str, str]) -> Dict[str, Any]:
        """Deserialize job data from Redis storage"""
        deserialized = {}

        for key, value in job_data.items():
            if key in ["created_at", "updated_at"]:
                deserialized[key] = datetime.fromisoformat(value)
            elif key in ["model_config", "training_params", "data_config", "metrics"]:
                try:
                    deserialized[key] = json.loads(value)
                except (json.JSONDecodeError, TypeError):
                    deserialized[key] = value
            elif key == "progress":
                deserialized[key] = float(value)
            else:
                deserialized[key] = value

        return deserialized