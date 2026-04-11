#!/bin/bash
# PyTorchRunner Launch Script with Hot Reloading

set -e

echo "🚀 PyTorchRunner Launch Script"
echo "=============================="

# Check if we're in the right directory
if [[ ! -f "main.py" ]]; then
    echo "❌ Error: main.py not found. Run this script from the PyTorchRunner directory."
    exit 1
fi

# Check if Redis is running
echo "📡 Checking Redis..."
if ! nc -z localhost 6379 2>/dev/null; then
    echo "⚠️  Redis not running. Starting Redis in Docker..."
    docker run -d --name pytorch-runner-redis -p 6379:6379 redis:alpine
    echo "✅ Redis started on port 6379"

    # Wait for Redis to be ready
    echo "⏳ Waiting for Redis to be ready..."
    for i in $(seq 1 30); do nc -z localhost 6379 2>/dev/null && break || sleep 1; done
    echo "✅ Redis ready"
else
    echo "✅ Redis already running on port 6379"
fi

# Check Python dependencies
echo "📦 Checking dependencies..."
if [[ ! -d "venv" ]]; then
    echo "🔧 Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install/upgrade dependencies
echo "📥 Installing dependencies..."
pip install -q -r requirements.txt

# Check MPS availability
echo "🧠 Checking MPS availability..."
python3 -c "
import torch
if torch.backends.mps.is_available():
    print('✅ MPS acceleration available')
else:
    print('⚠️  MPS not available - will fall back to CPU')
"

# Start PyTorchRunner with hot reloading
echo "🚀 Starting PyTorchRunner with hot reloading..."
echo "📍 Service will be available at: http://localhost:9100"
echo "🔄 Hot reloading enabled - code changes will auto-restart the service"
echo "🛑 Press Ctrl+C to stop"
echo ""

# Hot-reload is opt-in via PYTORCHRUNNER_DEV=1.
# WARNING: --reload kills all running jobs when any src/ file changes.
# Never enable it during long training runs (e.g. SpecLLM DQN).
if [[ "${PYTORCHRUNNER_DEV:-}" == "1" ]]; then
    RELOAD_FLAGS="--reload --reload-dir src"
    echo "⚠️  Dev mode: hot-reload ENABLED (kills running jobs on file change)"
else
    RELOAD_FLAGS=""
    echo "🔒 Production mode: hot-reload DISABLED (safe for long training runs)"
    echo "   Set PYTORCHRUNNER_DEV=1 to enable hot-reload"
fi

# Run PyTorchRunner
uvicorn src.server.script_api:app \
    --host 0.0.0.0 \
    --port 9100 \
    $RELOAD_FLAGS \
    --log-level info \
    --access-log