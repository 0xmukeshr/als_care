FROM python:3.10-slim

# Set working directory
WORKDIR /app

# Install Node.js and build essentials
RUN apt-get update && \
    apt-get install -y curl build-essential && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Show versions for debugging
RUN node -v && npm -v && python --version

# Copy Python requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Node.js package files and install dependencies
COPY als_client/package*.json ./als_client/
RUN cd als_client && npm install

# Copy the entire application
COPY . .

# Make start script executable
RUN chmod +x start.sh

# Set environment variable for port
ENV PORT=10000

# Set Python to unbuffered mode for proper logging
ENV PYTHONUNBUFFERED=1

# Expose the port the app runs on
EXPOSE 10000

# Run the start script when the container launches
CMD ["./start.sh"]