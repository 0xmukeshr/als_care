# ALS Cargiving assist AI

An intelligent information crawler and RAG (Retrieval-Augmented Generation) agent built using Pydantic AI and Supabase. The agent can crawl information websites, store content in a vector database, and provide intelligent answers to user questions by retrieving and analyzing relevant information chunks.

## Features

- information website crawling and chunking
- Vector database storage with Supabase
- Semantic search using OpenAI embeddings
- RAG-based question answering
- Support for code block preservation
- Streamlit UI for interactive querying
- Available as both API endpoint and web interface

## Prerequisites

- Python 3.11+
- Supabase account and database
- OpenAI API key
- Streamlit (for web interface)

## Installation

1. Install dependencies (recommended to use a Python virtual environment):
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

2. Set up environment variables:
   - Rename `.env.example` to `.env`
   - Edit `.env` with your API keys and preferences:
   ```env
   OPENAI_API_KEY=your_openai_api_key
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_KEY=your_supabase_service_key
   LLM_MODEL=gpt-4o-mini  # or your preferred OpenAI model
   ```

## Usage

### Database Setup

Execute the SQL commands in `site_page.sql` to:
1. Create the necessary tables
2. Enable vector similarity search
3. Set up Row Level Security policies

In Supabase, do this by going to the "SQL Editor" tab and pasting in the SQL into the editor there. Then click "Run".

### Crawl information

To crawl and store information in the vector database:

```bash
python crawl_pydantic_ai_docs.py
```

This will:
1. Fetch URLs from the information sitemap
2. Crawl each page and split into chunks
3. Generate embeddings and store in Supabase

### Streamlit Web Interface

For an interactive web interface to query the information:

```bash
streamlit run streamlit_ui.py
```

The interface will be available at `http://localhost:8501`

## Configuration

### Database Schema

The Supabase database uses the following schema:
```sql
CREATE TABLE site_page (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT,
    chunk_number INTEGER,
    title TEXT,
    summary TEXT,
    content TEXT,
    metadata JSONB,
    embedding VECTOR(1536)
);
```

### Chunking Configuration

You can configure chunking parameters in `crawl_pydantic_ai_docs.py`:
```python
chunk_size = 5000  # Characters per chunk
```

The chunker intelligently preserves:
- Code blocks
- Paragraph boundaries
- Sentence boundaries

## Project Structure

- `crawl_pydantic_ai_docs.py`: information crawler and processor
- `pydantic_ai_expert.py`: RAG agent implementation
- `streamlit_ui.py`: Web interface
- `site_page.sql`: Database setup commands
- `requirements.txt`: Project dependencies


## Error Handling

The system includes robust error handling for:
- Network failures during crawling
- API rate limits
- Database connection issues
- Embedding generation errors
- Invalid URLs or content
