from fastapi import FastAPI, BackgroundTasks
import uvicorn
import asyncio
import os
from  agent import main_loop

# Set fixed port for Render deployment
PORT = 10000

app = FastAPI(title="ALS AI Tweet Agent")

# Global variable to track the background task
background_task = None

@app.get("/")
async def root():
    """Root endpoint that confirms the service is running."""
    return {
        "status": "ok",
        "message": "ALS AI Tweet Agent is running"
    }

@app.get("/health")
async def health():
    """Health check endpoint for monitoring."""
    global background_task
    is_running = background_task is not None and not background_task.done()
    
    return {
        "status": "healthy" if is_running else "degraded",
        "background_task_running": is_running
    }

@app.on_event("startup")
async def startup_event():
    """Start the main loop when the FastAPI app starts."""
    global background_task
    
    # Start the main loop in the background
    background_task = asyncio.create_task(main_loop())
    
    print(f"ALS AI Tweet Agent started in background")
    print(f"Service running on fixed port {PORT}")

@app.on_event("shutdown")
async def shutdown_event():
    """Cancel the main loop when the FastAPI app shuts down."""
    global background_task
    
    # Cancel the background task if it's running
    if background_task:
        background_task.cancel()
        try:
            await background_task
        except asyncio.CancelledError:
            pass
    
    print("ALS AI Tweet Agent stopped")

if __name__ == "__main__":
    # Start the FastAPI app with fixed port
    uvicorn.run("api:app", host="0.0.0.0", port=PORT, reload=False)