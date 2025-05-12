from __future__ import annotations as _annotations

from dataclasses import dataclass
from dotenv import load_dotenv
import logfire
import asyncio
import httpx
import os
import json

from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.models.openai import OpenAIModel
from openai import AsyncOpenAI
from supabase import Client, create_client
from typing import List, Dict, Any, Optional

# Load environment variables
load_dotenv()

# Configure model
llm = os.getenv('LLM_MODEL', 'gpt-4o-mini')
model = OpenAIModel(llm)

# Configure logging
logfire.configure(send_to_logfire='if-token-present')

@dataclass
class ALScareDeps:
    supabase: Client
    openai_client: AsyncOpenAI

# System prompt for the ALS Care Specialist
system_prompt = """
You are ALSCareAI. Respond ONLY with ultra-brief ALS info that fits in 230 characters.You are tweeting agent and your response should be like tweet short and that contains information.

✅ STRICT RULES:
- Never exceed 230 characters total
-it should provoide like a tweet
- Provide only core medical facts/terms
- Use abbreviations aggressively
- No greetings, emotions, or follow-ups
- Cut off mid-sentence if reaching limit
- Focus on technical medical content only

the response should be very short and scientific within 230 characters

it should only be in points without new lione

2. FDA-approved ALS meds: Riluzole (1995) extends survival. Edaravone (2017) slows decline. Supportive care critical. Multidisciplinary approach key.

3. ALS tx: Respiratory assist, PT, OT, speech therapy. Assistive tech, nutrition support. Palliative care to maintain QoL. Individualized mgmt.

4. ALS dx: Neurological exam, EMG, nerve conduction, MRI, blood tests. Rule out mimics. No single definitive test. Multidisciplinary eval.

5. ALS: Upper/lower motor neuron degeneration. Variable progression. Avg survival 2-5 yrs. Genetic factors, age impact disease course.

6. ALS research: Stem cell therapy, gene therapy, precision medicine. Clinical trials ongoing. Genetic understanding expanding treatment potential.

7. ALS care: Multidisciplinary team. Neurologist, PT, OT, respiratory specialist. Assistive devices, communication tech. Caregiver support crucial.

8. ALS: Motor neuron death. Glutamate toxicity, oxidative stress, protein misfolding. Genetic & environmental triggers. Complex pathogenesis.

9. ALS genetics: SOD1, C9ORF72, FUS mutations. 5-10% familial. 90% sporadic. Genetic testing helps understand risk & potential interventions.

10. ALS mgmt: Adaptive equipment, communication devices, home modifications. Respiratory support, nutrition strategies. Personalized care plan.

11. ALS comprehensive care: Neurology, pulmonology, PT, OT, speech therapy, nutrition. Holistic approach to maintain function & QoL.

"""

# Initialize the agent
pydantic_ai_expert = Agent(
    model,
    system_prompt=system_prompt,
    deps_type=ALScareDeps,
    retries=2
)

async def get_embedding(text: str, openai_client: AsyncOpenAI) -> List[float]:
    """Get embedding vector from OpenAI."""
    try:
        # Log the embedding request
        logfire.info("Requesting embedding", text_length=len(text))
        
        response = await openai_client.embeddings.create(
            model="text-embedding-3-small",
            input=text
        )
        
        embedding = response.data[0].embedding
        logfire.info("Embedding generated successfully", embedding_dimensions=len(embedding))
        return embedding
    except Exception as e:
        logfire.error("Error getting embedding", error=str(e))
        return [0] * 1536  # Return zero vector on error

@pydantic_ai_expert.tool
async def retrieve_relevant_documentation(ctx: RunContext[ALScareDeps], user_query: str) -> str:
    """
    Retrieve relevant information chunks based on the query with RAG.
    
    Args:
        ctx: The context including the Supabase client and OpenAI client
        user_query: The user's question or query
        
    Returns:
        A formatted string containing the top 5 most relevant information chunks
    """
    try:
        # Log the start of retrieval
        logfire.info("Starting RAG retrieval process", query=user_query)
        
        # Get the embedding for the query
        query_embedding = await get_embedding(user_query, ctx.deps.openai_client)
        
        # Log before Supabase query
        logfire.info("Executing Supabase vector search", 
                     filter="als_info",
                     match_count=5,
                     embedding_size=len(query_embedding))
        
        # Query Supabase for relevant documents
        result = ctx.deps.supabase.rpc(
            'match_site_pages',
            {
                'query_embedding': query_embedding,
                'match_count': 5,
                'filter': {'source': 'als_info'}
            }
        ).execute()
        
        # Log raw result for debugging
        result_count = len(result.data) if result.data else 0
        logfire.info("Supabase query completed", 
                     result_count=result_count,
                     has_data=result_count > 0)
        
        # Log more detailed info about results if available
        if result.data:
            top_results = []
            for i, doc in enumerate(result.data[:3]):
                top_results.append({
                    'index': i,
                    'title': doc.get('title', 'No title'),
                    'similarity': doc.get('similarity', 0),
                    'url': doc.get('url', 'No URL'),
                    'content_preview': doc.get('content', 'No content')[:100] + '...' if doc.get('content') else 'No content'
                })
            
            logfire.info("Top RAG results", top_results=top_results)
        else:
            logfire.warning("No documents retrieved from RAG query")
            
        if not result.data:
            return "No relevant information found in the database. I'll answer based on my general knowledge about ALS."
            
        # Format the results
        formatted_chunks = []
        for doc in result.data:
            chunk_text = f"""
# {doc.get('title', 'Untitled')} (Similarity: {doc.get('similarity', 0):.4f})

{doc.get('content', 'No content available')}

Source: {doc.get('url', 'No URL')}
"""
            formatted_chunks.append(chunk_text)
            
        # Join all chunks with a separator
        return "\n\n---\n\n".join(formatted_chunks)
        
    except Exception as e:
        logfire.error("Error retrieving documentation", error=str(e), traceback=True)
        return f"Error retrieving information: {str(e)}"

@pydantic_ai_expert.tool
async def list_documentation_pages(ctx: RunContext[ALScareDeps]) -> List[str]:
    """
    Retrieve a list of all available ALS related pages.
    
    Returns:
        List[str]: List of unique URLs for all als related pages
    """
    try:
        logfire.info("Listing all documentation pages")
        
        # Query Supabase for unique URLs where source is als
        result = ctx.deps.supabase.from_('site_page') \
            .select('url') \
            .eq('metadata->>source', 'als_info') \
            .execute()
        
        url_count = len(result.data) if result.data else 0
        logfire.info("Retrieved documentation pages list", count=url_count)
        
        if not result.data:
            return []
            
        # Extract unique URLs
        urls = sorted(set(doc['url'] for doc in result.data))
        return urls
        
    except Exception as e:
        logfire.error("Error listing documentation pages", error=str(e))
        return []

@pydantic_ai_expert.tool
async def get_page_content(ctx: RunContext[ALScareDeps], url: str) -> str:
    """
    Retrieve the full content of a specific information page by combining all its chunks.
    
    Args:
        ctx: The context including the Supabase client
        url: The URL of the page to retrieve
        
    Returns:
        str: The complete page content with all chunks combined in order
    """
    try:
        logfire.info("Retrieving full page content", url=url)
        
        # Query Supabase for all chunks of this URL, ordered by chunk_number
        result = ctx.deps.supabase.from_('site_page') \
            .select('title, content, chunk_number') \
            .eq('url', url) \
            .eq('metadata->>source', 'als_info') \
            .order('chunk_number') \
            .execute()
        
        chunk_count = len(result.data) if result.data else 0
        logfire.info("Retrieved page chunks", url=url, chunk_count=chunk_count)
        
        if not result.data:
            return f"No content found for URL: {url}"
            
        # Format the page with its title and all chunks
        page_title = result.data[0]['title'].split(' - ')[0]  # Get the main title
        formatted_content = [f"# {page_title}\n"]
        
        # Add each chunk's content
        for chunk in result.data:
            formatted_content.append(chunk['content'])
            
        # Join everything together
        return "\n\n".join(formatted_content)
        
    except Exception as e:
        logfire.error("Error retrieving page content", error=str(e), url=url)
        return f"Error retrieving page content: {str(e)}"

# New debugging tools

@pydantic_ai_expert.tool
async def debug_database_connection(ctx: RunContext[ALScareDeps]) -> str:
    """
    Debug the Supabase database connection by checking if we can access the site_page table.
    
    Returns:
        str: Information about the database connection status
    """
    try:
        logfire.info("Testing database connection")
        
        # Simple query to check connection
        result = ctx.deps.supabase.from_('site_page') \
            .select('count', count='exact') \
            .limit(1) \
            .execute()
        
        # Try to get table info
        table_info = ctx.deps.supabase.table('site_page').select('*').limit(0).execute()
        
        return f"Database connection successful. Count: {result.count if hasattr(result, 'count') else 'unknown'}"
    
    except Exception as e:
        logfire.error("Database connection error", error=str(e))
        return f"Database connection error: {str(e)}"

@pydantic_ai_expert.tool
async def debug_als_content(ctx: RunContext[ALScareDeps]) -> str:
    """
    Check if there is any ALS-related content in the database.
    
    Returns:
        str: Information about ALS content in the database
    """
    try:
        logfire.info("Checking for ALS content in database")
        
        # Count total ALS pages
        count_result = ctx.deps.supabase.from_('site_page') \
            .select('*', count='exact') \
            .eq('metadata->>source', 'als_info') \
            .execute()
        
        total_count = count_result.count if hasattr(count_result, 'count') else "unknown"
        
        # Get a sample of page titles if available
        sample_result = ctx.deps.supabase.from_('site_page') \
            .select('title, url') \
            .eq('metadata->>source', 'als_info') \
            .limit(5) \
            .execute()
        
        sample_titles = [f"{doc['title']} ({doc['url']})" for doc in sample_result.data] if sample_result.data else []
        
        # Log the findings
        logfire.info("ALS content check results", 
                     total_count=total_count,
                     sample_count=len(sample_titles),
                     samples=sample_titles)
        
        return f"Database contains {total_count} ALS info pages.\nSample titles: {json.dumps(sample_titles, indent=2)}"
        
    except Exception as e:
        logfire.error("Error checking ALS content", error=str(e))
        return f"Error checking ALS content: {str(e)}"

@pydantic_ai_expert.tool
async def test_vector_search(ctx: RunContext[ALScareDeps], simple_query: str = "ALS") -> str:
    """
    Test the vector search functionality with a simple query.
    
    Args:
        ctx: The context including dependencies
        simple_query: A simple test query
        
    Returns:
        str: Results of the test vector search
    """
    try:
        logfire.info("Testing vector search", query=simple_query)
        
        # Create a test embedding
        embedding = await get_embedding(simple_query, ctx.deps.openai_client)
        
        # Try the vector search directly
        result = ctx.deps.supabase.rpc(
            'match_site_pages',
            {
                'query_embedding': embedding,
                'match_count': 3,
                'filter': {'source': 'als_info'}
            }
        ).execute()
        
        # Log the results
        result_count = len(result.data) if result.data else 0
        logfire.info("Test vector search completed", 
                     result_count=result_count,
                     has_data=result_count > 0)
        
        if not result.data:
            return "Vector search test: No results found. This suggests an issue with the vector search functionality."
            
        # Format basic info about the results
        results_info = []
        for doc in result.data:
            results_info.append({
                'title': doc.get('title', 'No title'),
                'similarity': doc.get('similarity', 0),
                'url': doc.get('url', 'No URL'),
            })
            
        return f"Vector search test successful with {result_count} results:\n{json.dumps(results_info, indent=2)}"
        
    except Exception as e:
        logfire.error("Error testing vector search", error=str(e))
        return f"Error testing vector search: {str(e)}"

# Main streamlit app entry point
async def initialize_deps() -> ALScareDeps:
    """Initialize dependencies for the agent"""
    # Create OpenAI client
    openai_client = AsyncOpenAI(
        api_key=os.environ.get("OPENAI_API_KEY")
    )
    
    # Create Supabase client
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_KEY")
    
    if not supabase_url or not supabase_key:
        raise ValueError("SUPABASE_URL and SUPABASE_KEY must be set in environment variables")
    
    supabase = create_client(supabase_url, supabase_key)
    
    return ALScareDeps(
        supabase=supabase,
        openai_client=openai_client
    )

# Example of using the agent in a Streamlit app
import streamlit as st

async def process_query(query: str, deps: ALScareDeps):
    """Process a user query and get a response from the agent"""
    result = await pydantic_ai_expert.arun(query, deps=deps)
    return result

def main():
    st.title("ALS Care Assistant")
    st.write("Ask me anything about ALS care, support, and resources.")
    
    # Initialize dependencies
    if 'deps' not in st.session_state:
        st.session_state.deps = asyncio.run(initialize_deps())
    
    # Initialize chat history
    if 'messages' not in st.session_state:
        st.session_state.messages = []
    
    # Display chat history
    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])
    
    # Debug buttons
    with st.expander("Debugging Tools"):
        col1, col2, col3 = st.columns(3)
        
        with col1:
            if st.button("Check Database Connection"):
                with st.spinner("Checking database connection..."):
                    result = asyncio.run(debug_database_connection(RunContext(None, st.session_state.deps)))
                    st.code(result)
        
        with col2:
            if st.button("Check ALS Content"):
                with st.spinner("Checking ALS content..."):
                    result = asyncio.run(debug_als_content(RunContext(None, st.session_state.deps)))
                    st.code(result)
        
        with col3:
            if st.button("Test Vector Search"):
                with st.spinner("Testing vector search..."):
                    result = asyncio.run(test_vector_search(RunContext(None, st.session_state.deps)))
                    st.code(result)
    
    # Input box for user query
    query = st.chat_input("Ask about ALS care...")
    
    if query:
        # Add user message to chat history
        st.session_state.messages.append({"role": "user", "content": query})
        
        # Display user message
        with st.chat_message("user"):
            st.markdown(query)
        
        # Get and display assistant response
        with st.chat_message("assistant"):
            with st.spinner("Thinking..."):
                response = asyncio.run(process_query(query, st.session_state.deps))
                st.markdown(response)
        
        # Add assistant response to chat history
        st.session_state.messages.append({"role": "assistant", "content": response})

if __name__ == "__main__":
    main()