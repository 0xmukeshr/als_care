#!/bin/bash

# This script explicitly binds to the port and ensures the service starts properly on Render

# Get the PORT environment variable, defaulting to 8000 if not set
PORT="${PORT:-10000}"

# Print information for debugging
echo "Starting service on port: $PORT"

# Execute Gunicorn with explicit binding to the port
exec gunicorn -w 4 -k uvicorn.workers.UvicornWorker -b "0.0.0.0:$PORT" api:app