"""
PyTorchRunner FastAPI Server
[service.api.1] FastAPI server with async request handling for training job lifecycle management.
"""
import asyncio
import uuid
from datetime import datetime
from typing import Dict, Any, Optional
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import torch

from ..queue.redis_queue import JobQueue
from ..training.mps_trainer import MPSTrainer


class TrainingJobRequest(BaseModel):
    """Training job submission request"""
    ml_model_config: Dict[str, Any]
    training_params: Dict[str, Any]
    data_config: Dict[str, Any]
    project_path: Optional[str] = None  # Path to project for dynamic imports
    job_name: Optional[str] = None
    gpu_type: Optional[str] = None  # "mps", "3090", "5090", "any", or None (any)


class JobStatus(BaseModel):
    """Job status response"""
    job_id: str
    status: str  # queued, running, completed, failed
    progress: float  # 0.0 - 1.0
    metrics: Dict[str, Any]
    created_at: datetime
    updated_at: datetime
    error: Optional[str] = None
    gpu_type: Optional[str] = None


class HealthStatus(BaseModel):
    """Service health status"""
    service: str = "PyTorchRunner"
    status: str
    mps_available: bool
    mps_memory_total: Optional[int] = None
    mps_memory_used: Optional[int] = None
    queue_size: int
    active_jobs: int


# Initialize FastAPI app
app = FastAPI(
    title="PyTorchRunner",
    description="MPS Training Service for Docker Agents",
    version="1.0.0"
)

# Initialize components
job_queue = JobQueue()
mps_trainer = MPSTrainer()


@app.on_event("startup")
async def startup_event():
    """Initialize services on startup"""
    await job_queue.connect()
    mps_trainer.initialize()


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown"""
    await job_queue.disconnect()
    mps_trainer.cleanup()


@app.post("/train", response_model=Dict[str, str])
async def submit_training_job(
    request: TrainingJobRequest,
    background_tasks: BackgroundTasks
) -> Dict[str, str]:
    """
    [api.train.1] POST /train endpoint accepting model config, training parameters, and data specifications.
    """
    # Generate job ID
    job_id = str(uuid.uuid4())

    # Validate MPS availability
    if not torch.backends.mps.is_available():
        raise HTTPException(
            status_code=503,
            detail="MPS not available on this system"
        )

    # Create job record
    job_data = {
        "job_id": job_id,
        "model_config": request.ml_model_config,
        "training_params": request.training_params,
        "data_config": request.data_config,
        "project_path": request.project_path,
        "job_name": request.job_name or f"job-{job_id[:8]}",
        "gpu_type": request.gpu_type,
        "status": "queued",
        "progress": 0.0,
        "metrics": {},
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow()
    }

    # Queue the job to the appropriate GPU-specific queue
    await job_queue.enqueue_job(job_id, job_data, gpu_type=request.gpu_type)

    # Start processing in background
    background_tasks.add_task(process_training_job, job_id)

    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}", response_model=JobStatus)
async def get_job_status(job_id: str) -> JobStatus:
    """
    [api.jobs.1] GET /jobs/{id} endpoint providing real-time progress, metrics, and completion status.
    """
    job_data = await job_queue.get_job_status(job_id)

    if not job_data:
        raise HTTPException(status_code=404, detail="Job not found")

    return JobStatus(**job_data)


@app.get("/health", response_model=HealthStatus)
async def health_check() -> HealthStatus:
    """
    [api.health.1] GET /health endpoint reporting service status, MPS availability, and queue metrics.
    """
    # Check MPS availability and memory
    mps_available = torch.backends.mps.is_available()
    mps_memory_total = None
    mps_memory_used = None

    if mps_available:
        try:
            # Get MPS memory info if available
            mps_memory_total = torch.mps.driver_allocated_memory()
            mps_memory_used = torch.mps.current_allocated_memory()
        except Exception:
            pass  # Memory info not available on all systems

    # Get queue metrics
    queue_size = await job_queue.get_queue_size()
    active_jobs = await job_queue.get_active_job_count()

    return HealthStatus(
        status="healthy" if mps_available else "degraded",
        mps_available=mps_available,
        mps_memory_total=mps_memory_total,
        mps_memory_used=mps_memory_used,
        queue_size=queue_size,
        active_jobs=active_jobs
    )


async def process_training_job(job_id: str):
    """Background task to process training jobs"""
    try:
        # Get job data
        job_data = await job_queue.get_job_status(job_id)
        if not job_data:
            return

        # Update status to running
        await job_queue.update_job_status(job_id, "running", 0.0)

        # Execute training
        await mps_trainer.train_model(
            job_id=job_id,
            model_config=job_data["model_config"],
            training_params=job_data["training_params"],
            data_config=job_data["data_config"],
            project_path=job_data.get("project_path"),
            progress_callback=lambda progress, metrics: asyncio.create_task(
                job_queue.update_job_progress(job_id, progress, metrics)
            )
        )

        # Mark as completed
        await job_queue.update_job_status(job_id, "completed", 1.0)

    except Exception as e:
        # Mark as failed with error
        await job_queue.update_job_status(
            job_id, "failed", 0.0, error=str(e)
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "src.server.api:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )