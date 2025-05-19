from __future__ import annotations
from typing import Literal, TypedDict, List, Dict, Any, Optional
import asyncio
import os
import json
import time
from datetime import datetime
import logfire
import aiohttp
from supabase import Client
from openai import AsyncOpenAI

# Import all the message part classes
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    UserPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    RetryPromptPart,
    ModelMessagesTypeAdapter
)
from pydantic_ai_expert import pydantic_ai_expert, ALScareDeps

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

# API configuration
API_BASE_URL = os.getenv("API_BASE_URL")
POLLING_INTERVAL = int(os.getenv("POLLING_INTERVAL", "10"))  # seconds

openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
supabase: Client = Client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY")
)

# Configure logfire to suppress warnings (optional)
logfire.configure(send_to_logfire='never')

class TweetInfo(TypedDict):
    """Format of tweet information from API."""
    id: str
    username: str
    content: str


class ChatMessage(TypedDict):
    """Format of messages in conversation history."""
    role: Literal['user', 'assistant', 'system']
    timestamp: str
    content: str


async def fetch_current_tweet() -> Optional[TweetInfo]:
    """
    Fetch the current tweet that needs processing from the API.
    Returns None if there's no active tweet.
    """
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{API_BASE_URL}/api/current-tweet") as response:
                if response.status == 404:
                    return None
                
                if response.status == 200:
                    data = await response.json()
                    return data.get("tweet")
                
                return None
    except Exception as e:
        print(f"Error fetching current tweet: {e}")
        return None


async def send_tweet_response(tweet_id: str, response: str) -> bool:
    """
    Send the AI-generated response back to the API.
    Returns True if successful, False otherwise.
    """
    try:
        async with aiohttp.ClientSession() as session:
            payload = {
                "tweetId": tweet_id,
                "response": response
            }
            
            async with session.post(
                f"{API_BASE_URL}/api/tweet-response", 
                json=payload
            ) as response:
                
                if response.status == 200:
                    return True
                else:
                    print(f"API returned status code {response.status}")
                    return False
    except Exception as e:
        print(f"Error sending tweet response: {e}")
        return False


def convert_message_to_chat_format(message) -> ChatMessage:
    """
    Convert a ModelRequest or ModelResponse to the ChatMessage format.
    """
    role = "assistant" if isinstance(message, ModelResponse) else "user"
    content = ""
    
    if hasattr(message, 'parts'):
        for part in message.parts:
            if part.part_kind == 'text':
                content = part.content
            elif part.part_kind == 'user-prompt':
                content = part.content
            elif part.part_kind == 'system-prompt':
                role = "system"
                content = part.content
    
    return {
        "role": role,
        "timestamp": datetime.now().isoformat(),
        "content": content
    }


async def process_user_input(user_input: str, message_history: List[Any]):
    """
    Process user input and return the agent's response.
    """
    # Prepare dependencies
    deps = ALScareDeps(
        supabase=supabase,
        openai_client=openai_client
    )

    # Run the agent
    result = await pydantic_ai_expert.run(
        user_input,
        deps=deps,
        message_history=message_history,
    )
    
    # Extract the response text
    response_text = ""
    for msg in result.new_messages():
        if isinstance(msg, ModelResponse):
            for part in msg.parts:
                if part.part_kind == 'text':
                    response_text = part.content
                    break
    
    return result.new_messages(), response_text


async def main_loop():
    """
    Main loop that periodically checks for tweets to process,
    processes them, and sends the response back to the API.
    """
    # Initialize conversation history for the agent
    message_history = []
    
    print("ALS AI Tweet Agent started. Checking for tweets...")
    
    while True:
        try:
            # Fetch current tweet that needs processing
            tweet_info = await fetch_current_tweet()
            
            if tweet_info:
                tweet_id = tweet_info["id"]
                tweet_content = tweet_info["content"]
                tweet_username = tweet_info["username"]
                
                print(f"Processing tweet from @{tweet_username}: {tweet_content[:50]}...")
                
                # Create user message
                user_message = ModelRequest(parts=[UserPromptPart(content=tweet_content)])
                message_history.append(user_message)
                
                # Process input
                new_messages, response_text = await process_user_input(tweet_content, message_history)
                message_history.extend(new_messages)
                
                # Send response back to the API
                success = await send_tweet_response(tweet_id, response_text)
                
                if success:
                    print(f"Response for tweet {tweet_id} sent successfully")
                else:
                    print(f"Failed to send response for tweet {tweet_id}")
                
                # Wait a bit longer after processing a tweet
                await asyncio.sleep(POLLING_INTERVAL * 2)
            else:
                # No tweet to process, wait for the next polling interval
                await asyncio.sleep(POLLING_INTERVAL)
                
        except Exception as e:
            print(f"Error in main loop: {e}")
            await asyncio.sleep(POLLING_INTERVAL)


if __name__ == "__main__":
    try:
        print(f"ALS AI Tweet Agent is running.")
        print(f"API Base URL: {API_BASE_URL}")
        print(f"Polling interval: {POLLING_INTERVAL} seconds")
        
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\nShutting down ALS AI Tweet Agent...")

