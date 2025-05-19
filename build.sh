#!/bin/bash

# File: build.sh
# Purpose: Build script for Render deployment

# Enable error reporting
set -e

echo "Starting build process..."

# Install Python dependencies
echo "Installing Python dependencies..."
pip install -r requirements.txt

# Install Node.js dependencies for the client
echo "Installing Node.js dependencies..."
cd als_client
npm install

# Build TypeScript files if needed
if [ -f "tsconfig.json" ]; then
  echo "Compiling TypeScript..."
  npm run build
fi

# Return to root directory
cd ..

# Make start script executable
chmod +x start.sh

echo "Build completed successfully!"