from __future__ import annotations
from typing import Literal, TypedDict, List, Dict, Any, Optional
import asyncio
import os
import json
import time
from datetime import datetime
import logfire
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

openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
supabase: Client = Client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY")
)

# Configure logfire to suppress warnings (optional)
logfire.configure(send_to_logfire='never')

# File paths
INPUT_FILE = "input.json"
OUTPUT_FILE = "output.json"

class ChatMessage(TypedDict):
    """Format of messages in JSON files."""
    role: Literal['user', 'assistant', 'system']
    timestamp: str
    content: str


def load_input() -> Optional[str]:
    """
    Load user input from the input JSON file.
    Returns None if the file doesn't exist or is empty.
    """
    try:
        with open(INPUT_FILE, 'r') as f:
            data = json.load(f)
            # Check for new input
            if data.get("processed", True) is False:
                return data.get("message", "")
            return None
    except (FileNotFoundError, json.JSONDecodeError):
        # Create default input file if it doesn't exist
        with open(INPUT_FILE, 'w') as f:
            json.dump({
                "message": "",
                "processed": True
            }, f, indent=2)
        return None


def mark_input_as_processed():
    """Mark the input as processed."""
    try:
        with open(INPUT_FILE, 'r') as f:
            data = json.load(f)
        
        data["processed"] = True
        
        with open(INPUT_FILE, 'w') as f:
            json.dump(data, f, indent=2)
    except (FileNotFoundError, json.JSONDecodeError):
        pass


def save_output(messages: List[ChatMessage]):
    """Save messages to output JSON file."""
    with open(OUTPUT_FILE, 'w') as f:
        json.dump({"messages": messages}, f, indent=2)


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
    Main loop that periodically checks for user input,
    processes it, and saves the response.
    """
    # Initialize conversation history for the agent (not for output)
    message_history = []
    
    print("ALS AI Agent started. Checking for input...")
    
    while True:
        user_input = load_input()
        
        if user_input:
            print(f"Received input: {user_input}")
            
            # Create user message
            user_message = ModelRequest(parts=[UserPromptPart(content=user_input)])
            message_history.append(user_message)
            
            # Process input
            new_messages, response_text = await process_user_input(user_input, message_history)
            message_history.extend(new_messages)
            
            # Create fresh message array for output with just this exchange
            current_exchange = [
                {
                    "role": "user",
                    "timestamp": datetime.now().isoformat(),
                    "content": user_input
                },
                {
                    "role": "assistant",
                    "timestamp": datetime.now().isoformat(),
                    "content": response_text
                }
            ]
            
            # Save only the current exchange to output file (overwrites previous content)
            save_output(current_exchange)
            
            # Mark input as processed
            mark_input_as_processed()
            
            print(f"Response saved to {OUTPUT_FILE}")
        
        # Wait before checking again
        await asyncio.sleep(1)


if __name__ == "__main__":
    try:
        # Make sure output file exists
        if not os.path.exists(OUTPUT_FILE):
            save_output([])
        
        print(f"ALS AI Agent is running.")
        print(f"To interact: Update {INPUT_FILE} with a new message and set 'processed' to false")
        print(f"Responses will be saved to {OUTPUT_FILE}")
        
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\nShutting down ALS AI Agent...")