"""
PyTorchRunner Main Entry Point - Script Executor
"""
import os
import uvicorn

if __name__ == "__main__":
    # Hot-reload is opt-in: set PYTORCHRUNNER_DEV=1 for development.
    # WARNING: reload=True kills all running jobs on source-file changes —
    # never enable it during long training runs.
    dev_mode = os.environ.get("PYTORCHRUNNER_DEV", "").strip() in ("1", "true", "yes")

    uvicorn.run(
        "src.server.script_api:app",
        host="0.0.0.0",
        port=9100,
        reload=dev_mode,
        reload_dirs=["src"] if dev_mode else None,
        log_level="info",
        access_log=True,
        loop="asyncio",
    )