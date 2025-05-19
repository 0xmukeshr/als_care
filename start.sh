#!/bin/bash
set -e  # Exit on error

# Create a Python virtual environment
python3 -m venv venv

# Activate the virtual environment
source venv/bin/activate

# Install Python dependencies
pip install --upgrade pip
pip install -r requirements.txt

# Go to als_client and install Node dependencies
cd als_client
npm install

# Run Python backend in background
cd ..
source venv/bin/activate  # Just to be safe
python3 agent.py &

# Start Node app
cd als_client
npm run dev
