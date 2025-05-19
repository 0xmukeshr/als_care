# AI Expert Project

This project consists of a Python backend agent and a TypeScript/Node.js client for ALS (Agent Language Service). This README provides instructions on how to set up and run the project.

## Project Structure

```
.
├── README.md
├── agent.py                  # Main Python agent file
├── pydantic_ai_expert.py     # Pydantic AI expert module
├── crawl_pydantic_ai_docs.py # Script to crawl Pydantic documentation
├── streamlit_ui.py           # Streamlit UI for the project
├── als_client/               # ALS client directory
│   ├── src/                  # TypeScript source files
│   └── agent.py              # Agent files
└── ...                       # Other project files
```

## Prerequisites

- Python 3.10 or higher
- Node.js 16 or higher
- npm

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/0xmukeshr/als_care.git
cd als_care
```

### 2. Python Environment Setup

Create and activate a virtual environment:

```bash
python -m venv venv
source venv/bin/activate  # On Windows, use: venv\Scripts\activate
```

Install Python dependencies:

```bash
pip install -r requirements.txt
```

### 3. ALS Client Setup

Navigate to the ALS client directory and install dependencies:

```bash
cd als_client
npm install
```

## Environment Configuration

### 1. Root Directory Environment

Create a `.env` file in the root directory with the following variables (adjust as needed):

```
# Get your Open AI API Key by following these instructions -
# https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key
# You only need this environment variable set if you are using GPT (and not Ollama)
OPENAI_API_KEY=

# For the Supabase version (sample_supabase_agent.py), set your Supabase URL and Service Key.
# Get your SUPABASE_URL from the API section of your Supabase project settings -
# https://supabase.com/dashboard/project/<your project ID>/settings/api
SUPABASE_URL=

# Get your SUPABASE_SERVICE_KEY from the API section of your Supabase project settings -
# https://supabase.com/dashboard/project/<your project ID>/settings/api
# On this page it is called the service_role secret.
SUPABASE_SERVICE_KEY=

# The LLM you want to use from OpenAI. See the list of models here:
# https://platform.openai.com/docs/models
# Example: gpt-4o-mini
LLM_MODEL=

API_BASE_URL=


```

### 2. ALS Client Environment

Create a `.env` file in the `als_client` directory with the following variables (adjust as needed):

```
# API Configuration
TWITTER_USERNAME=
TWITTER_PASSWORD=
TWITTER_EMAIL=
SEARCH_INTERVAL_MINUTES=2
TWEET_INTERVAL_MINUTES=5
MAX_TWEETS_TO_FETCH=1
MAX_QUEUE_SIZE=50
OPENAI_API_KEY=
```

## Running the Project

### 1. Start the Python Backend

In the root directory (with the virtual environment activated):

```bash
python3 agent.py
```

This will start the Python backend service.

### 2. Start the ALS Client

In a new terminal, navigate to the ALS client directory:

```bash
cd als_client
npm run dev
```

This will start the ALS client service in development mode.

## Additional Components

### Streamlit UI (Optional)

To run the Streamlit UI:

```bash
streamlit run streamlit_ui.py
```

### Crawling Pydantic Documentation (Optional)

To update the crawled Pydantic documentation:

```bash
python crawl_pydantic_ai_docs.py
```

## Troubleshooting

### Common Issues

1. **Port Already in Use**
   - Change the port in the respective `.env` file

2. **API Key Issues**
   - Ensure all API keys are correctly set in the `.env` files

3. **Module Not Found Errors**
   - Make sure you've installed all dependencies with `pip install -r requirements.txt`
   - Check that you're running commands from the correct directory

4. **ALS Client Build Issues**
   - Try running `npm clean-install` in the `als_client` directory

## Development

- Python files follow PEP 8 guidelines
- TypeScript files use ESLint with recommended rules
- Use `npm run build` in the `als_client` directory to build the production version
