#!/bin/bash

# File: start.sh
# Purpose: Start both Node.js and Python services in parallel for Render deployment

# Enable error reporting and debugging
set -e

# Print environment info for debugging (omits sensitive values)
echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"
echo "Python version: $(python --version)"
echo "Current directory: $(pwd)"
echo "Directory contents: $(ls -la)"

# Set default port if not provided by environment
export PORT=${PORT:-10000}
echo "Using PORT: $PORT"

# Start Python agent service
echo "Starting Python agent service..."
python agent.py &
PYTHON_PID=$!
echo "Python service started with PID: $PYTHON_PID"

# Navigate to Node.js directory and install dependencies if needed
echo "Setting up Node.js service..."
cd als_client

# Check if node_modules exists, if not, install dependencies
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/tsc" ]; then
    echo "Installing Node.js dependencies..."
    npm install
fi

# Build TypeScript if needed (only in production)
if [ "$NODE_ENV" = "production" ]; then
    echo "Building TypeScript code..."
    npm run build
fi

# Start the Node.js service
echo "Starting Node.js service..."
npm start &
NODE_PID=$!
echo "Node service started with PID: $NODE_PID"

# Go back to root directory
cd ..

# Function to handle termination
cleanup() {
    echo "Received shutdown signal, terminating services..."
    kill -TERM $PYTHON_PID 2>/dev/null || true
    kill -TERM $NODE_PID 2>/dev/null || true
    exit 0
}

# Set up signal trap
trap cleanup SIGINT SIGTERM

# Log message
echo "All services started. Waiting for services to exit..."

# Wait for either process to exit
wait $PYTHON_PID $NODE_PIDgit add Dockerfile start.sh build.sh