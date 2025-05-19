#!/bin/bash

# Exit on any error
set -e

# 1. Python environment setup
echo "Installing Python dependencies..."
pipx install -r requirements.txt

# 2. Node.js environment setup (inside als_client)
echo "Installing Node dependencies..."
cd als_client
npm install

# 3. Run both services
echo "Starting both services..."

# Start Python backend (adjust path if needed)
cd ..
python3 agent.py &

# Start Node frontend/client (from als_client)
cd als_client
npm run dev
