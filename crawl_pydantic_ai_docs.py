import os
import sys
import json
import asyncio
import requests
from bs4 import BeautifulSoup
from xml.etree import ElementTree
from typing import List, Dict, Any, Set
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlparse, urljoin
from dotenv import load_dotenv

from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
from openai import AsyncOpenAI
from supabase import create_client, Client
load_dotenv()

# Initialize OpenAI and Supabase clients
openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
supabase: Client = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY")
)

@dataclass
class ProcessedChunk:
    url: str
    chunk_number: int
    title: str
    summary: str
    content: str
    metadata: Dict[str, Any]
    embedding: List[float]

def chunk_text(text: str, chunk_size: int = 4000) -> List[str]:
    """Split text into chunks, respecting code blocks and paragraphs.
    Uses slightly smaller chunks to optimize token usage."""
    chunks = []
    start = 0
    text_length = len(text)

    while start < text_length:
        # Calculate end position
        end = start + chunk_size

        # If we're at the end of the text, just take what's left
        if end >= text_length:
            chunks.append(text[start:].strip())
            break

        # Try to find a code block boundary first (```)
        chunk = text[start:end]
        code_block = chunk.rfind('```')
        if code_block != -1 and code_block > chunk_size * 0.3:
            end = start + code_block

        # If no code block, try to break at a paragraph
        elif '\n\n' in chunk:
            last_break = chunk.rfind('\n\n')
            if last_break > chunk_size * 0.3:
                end = start + last_break

        # If no paragraph break, try to break at a sentence
        elif '. ' in chunk:
            last_period = chunk.rfind('. ')
            if last_period > chunk_size * 0.3:
                end = start + last_period + 1

        # Extract chunk and clean it up
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        # Move start position for next chunk
        start = end
    
    return chunks

async def get_title_and_summary(chunk: str, url: str) -> Dict[str, str]:
    """Extract title and summary using GPT-4."""
    system_prompt = """Extract concise title and summary from chunks. Return JSON with 'title' and 'summary' keys.
    Title: Extract document title or create descriptive heading if mid-document.
    Summary: Briefly capture main points in 1-2 sentences."""
    
    # Use a smaller context window to reduce tokens
    context_length = min(500, len(chunk))
    content_preview = chunk[:context_length]
    
    try:
        response = await openai_client.chat.completions.create(
            model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"URL: {url}\nContent: {content_preview}"}
            ],
            response_format={"type": "json_object"},
            max_tokens=150  # Limit response size
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        print(f"Error getting title and summary: {e}")
        return {"title": "Error processing title", "summary": "Error processing summary"}

async def get_embedding(text: str) -> List[float]:
    """Get embedding vector from OpenAI."""
    # Truncate text to reduce token usage - most embedding models have a limit anyway
    # Use the first ~8000 chars which is typically around 2000 tokens
    truncated_text = text[:8000] if len(text) > 8000 else text
    
    try:
        response = await openai_client.embeddings.create(
            model="text-embedding-3-small",
            input=truncated_text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"Error getting embedding: {e}")
        return [0] * 1536  # Return zero vector on error

async def process_chunk(chunk: str, chunk_number: int, url: str) -> ProcessedChunk:
    """Process a single chunk of text."""
    # Get title and summary
    extracted = await get_title_and_summary(chunk, url)
    
    # Get embedding
    embedding = await get_embedding(chunk)
    
    # Create metadata
    metadata = {
        "source": "als_info",
        "chunk_size": len(chunk),
        "crawled_at": datetime.now(timezone.utc).isoformat(),
        "url_path": urlparse(url).path
    }
    
    return ProcessedChunk(
        url=url,
        chunk_number=chunk_number,
        title=extracted['title'],
        summary=extracted['summary'],
        content=chunk,  # Store the original chunk content
        metadata=metadata,
        embedding=embedding
    )

async def insert_chunk(chunk: ProcessedChunk):
    """Insert a processed chunk into Supabase."""
    try:
        data = {
            "url": chunk.url,
            "chunk_number": chunk.chunk_number,
            "title": chunk.title,
            "summary": chunk.summary,
            "content": chunk.content,
            "metadata": chunk.metadata,
            "embedding": chunk.embedding
        }
        
        result = supabase.table("site_page").insert(data).execute()
        print(f"Inserted chunk {chunk.chunk_number} for {chunk.url}")
        return result
    except Exception as e:
        print(f"Error inserting chunk: {e}")
        return None

async def process_and_store_document(url: str, markdown: str):
    """Process a document and store its chunks in parallel."""
    # Split into chunks
    chunks = chunk_text(markdown)
    
    # Process chunks in parallel
    tasks = [
        process_chunk(chunk, i, url) 
        for i, chunk in enumerate(chunks)
    ]
    processed_chunks = await asyncio.gather(*tasks)
    
    # Store chunks in parallel
    insert_tasks = [
        insert_chunk(chunk) 
        for chunk in processed_chunks
    ]
    await asyncio.gather(*insert_tasks)

async def crawl_parallel(urls: List[str], max_concurrent: int = 5):
    """Crawl multiple URLs in parallel with a concurrency limit."""
    browser_config = BrowserConfig(
        headless=True,
        verbose=False,
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        extra_args=["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
    )
    crawl_config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS)

    # Create the crawler instance
    crawler = AsyncWebCrawler(config=browser_config)
    await crawler.start()

    try:
        # Create a semaphore to limit concurrency
        semaphore = asyncio.Semaphore(max_concurrent)
        
        async def process_url(url: str):
            async with semaphore:
                result = await crawler.arun(
                    url=url,
                    config=crawl_config,
                    session_id="session1"
                )
                if result.success:
                    print(f"Successfully crawled: {url}")
                    await process_and_store_document(url, result.markdown_v2.raw_markdown)
                else:
                    print(f"Failed: {url} - Error: {result.error_message}")
        
        # Process all URLs in parallel with limited concurrency
        await asyncio.gather(*[process_url(url) for url in urls])
    finally:
        await crawler.close()

def get_browser_headers():
    """Return headers that mimic a real browser."""
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "max-age=0",
    }

def try_find_sitemap_urls() -> List[str]:
    """Try different approaches to find the sitemap."""
    possible_sitemap_urls = [
    "https://alsworldwide.org/sitemap.xml",                                                                 
    "https://alsworldwide.org/sitemap_index.xml",
    "https://alsworldwide.org/sitemap-index.xml",
    "https://alsworldwide.org/wp-sitemap.xml",
    "https://alsworldwide.org/wp-sitemap-posts-post-1.xml",
    "https://alsworldwide.org/robots.txt"  # To check for Sitemap: directive
    ]
    
    headers = get_browser_headers()
    
    for url in possible_sitemap_urls:
        try:
            print(f"Trying to fetch sitemap from: {url}")
            response = requests.get(url, headers=headers, timeout=10)
            response.raise_for_status()
            
            if url.endswith("robots.txt"):
                # Parse robots.txt to find sitemap
                for line in response.text.split('\n'):
                    if line.lower().startswith("sitemap:"):
                        sitemap_url = line.split(":", 1)[1].strip()
                        print(f"Found sitemap in robots.txt: {sitemap_url}")
                        sitemap_response = requests.get(sitemap_url, headers=headers)
                        sitemap_response.raise_for_status()
                        return extract_urls_from_sitemap(sitemap_response.content)
            else:
                # Parse XML sitemap
                return extract_urls_from_sitemap(response.content)
                
        except Exception as e:
            print(f"Could not fetch sitemap from {url}: {e}")
    
    return []

def extract_urls_from_sitemap(content: bytes) -> List[str]:
    """Extract URLs from sitemap XML content."""
    try:
        root = ElementTree.fromstring(content)
        # Extract all URLs from the sitemap
        namespace = {'ns': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
        
        # First check if this is a sitemap index
        sitemap_tags = root.findall('.//ns:sitemap/ns:loc', namespace)
        if sitemap_tags:
            # This is a sitemap index, we need to fetch each sitemap
            all_urls = []
            headers = get_browser_headers()
            
            for sitemap in sitemap_tags:
                try:
                    sitemap_url = sitemap.text
                    print(f"Fetching sub-sitemap: {sitemap_url}")
                    sub_response = requests.get(sitemap_url, headers=headers)
                    sub_response.raise_for_status()
                    urls = extract_urls_from_sitemap(sub_response.content)
                    all_urls.extend(urls)
                except Exception as e:
                    print(f"Error fetching sub-sitemap {sitemap.text}: {e}")
            
            return all_urls
        else:
            # This is a regular sitemap
            urls = [loc.text for loc in root.findall('.//ns:url/ns:loc', namespace)]
            return urls
            
    except Exception as e:
        print(f"Error parsing sitemap: {e}")
        return []

def scrape_urls_from_homepage(base_url: str, depth: int = 1) -> List[str]:
    """Scrape URLs directly from the homepage and related pages."""
    headers = get_browser_headers()
    all_urls = set()
    visited = set()
    to_visit = {base_url}
    
    # Define URL filtering function
    base_domain = urlparse(base_url).netloc
    skip_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.pdf', '.mp3', '.mp4', '.css', '.js'}
    skip_paths = {'/wp-json/', '/wp-admin/', '/wp-content/', '/tag/', '/category/', '/author/'}
    
    # Optimized validity check
    def is_valid_url(url):
        parsed = urlparse(url)
        # Check domain, fragments, and file extensions
        if (parsed.netloc and parsed.netloc != base_domain) or parsed.fragment:
            return False
        
        path = parsed.path.lower()
        if any(ext in path for ext in skip_extensions) or any(skip in path for skip in skip_paths):
            return False
        
        return True
    
    # URL discovery with depth limit
    for current_depth in range(depth):
        if not to_visit:
            break
            
        current_urls = to_visit
        to_visit = set()
        
        for url in current_urls:
            if url in visited:
                continue
                
            visited.add(url)
            try:
                print(f"Fetching URLs from: {url}")
                response = requests.get(url, headers=headers, timeout=10)
                if response.status_code != 200:
                    continue
                
                # Use minimal parsing for speed
                soup = BeautifulSoup(response.text, 'html.parser')
                links = soup.find_all('a', href=True)
                
                # Process links
                for link in links:
                    href = link['href']
                    full_url = urljoin(url, href)
                    
                    if is_valid_url(full_url) and full_url not in visited and full_url not in all_urls:
                        all_urls.add(full_url)
                        if current_depth < depth - 1:
                            to_visit.add(full_url)
                            
            except Exception as e:
                print(f"Error scraping {url}: {e}")
    
    return list(all_urls)

def get_als_info_urls() -> List[str]:
    """Get URLs from ALS information website."""
    # First try to use sitemaps
    urls = try_find_sitemap_urls()
    
    # If sitemaps fail, try to scrape URLs from the homepage
    if not urls:
        print("No URLs found in sitemap, scraping from homepage...")
        urls = scrape_urls_from_homepage("https://alsworldwide.org/", depth=2)
    
    # If we still don't have URLs, use a predefined list of important pages
    if not urls:
        print("Falling back to hardcoded URLs")
        urls = [
        "https://alsworldwide.org/",
        "https://alsworldwide.org/about",
        "https://alsworldwide.org/patients-families",
        "https://alsworldwide.org/our-work",
        "https://alsworldwide.org/news",
        "https://alsworldwide.org/contact"
        ]
    
    return urls

async def main():
    # Get URLs from ALS info site
    urls = get_als_info_urls()
    if not urls:
        print("No URLs found to crawl")
        return
    
    print(f"Found {len(urls)} URLs to crawl")
    
    # Filter to only essential pages
    filtered_urls = filter_essential_urls(urls)
    print(f"Filtered to {len(filtered_urls)} essential URLs")
    
    # Crawl the filtered URLs
    await crawl_parallel(filtered_urls, max_concurrent=3)

def filter_essential_urls(urls: List[str]) -> List[str]:
    """Filter URLs to only include essential ALS information pages."""
    # Define priority keywords for inclusion
    priority_keywords = [
        '/what-is-als/', '/about/', '/events/', '/news/', 
        '/treatment/', '/care/', '/support/', '/research/',
        '/team/', '/staff/', '/board/', '/contact/',
        '/resources/', '/community/', '/programs/', '/advocacy/',
        '/faq/', '/donate/', '/volunteer/', '/mission/',
        '/vision/', '/achievements/', '/impact/', '/story/',
        '/clinics/', '/centers/', '/doctors/', '/specialists/',
        '/therapy/', '/medication/', '/clinic-directory/', '/support-groups/','/fund/','/support/','/in/','/blog/','/counseling/','/treatment-options/','/symptoms/','/diagnosis/','/contact-us/','/news/','/get-involved/'
    ]
    
    # Define patterns to exclude
    exclude_patterns = [
        '/attachment', '/author/', '/comment-page-', 
        '/feed/', '/trackback/', '/wp-json/', '/wp-content/',
        '/page/', '/tag/', '/category/', '/2019/', '/2020/', '/2021/', '/2022/', '/2023/',
        '.jpg', '.jpeg', '.png', '.pdf', '.mp3', '.mp4', '.css', '.js'
    ]
    
    # First pass: include pages with priority keywords
    essential_urls = []
    for url in urls:
        # Skip URLs that match exclude patterns
        if any(pattern in url.lower() for pattern in exclude_patterns):
            continue
            
        # Include URLs with priority keywords
        if any(keyword in url.lower() for keyword in priority_keywords):
            essential_urls.append(url)
    
    # If we don't have enough essential URLs, include the homepage and main sections
    if len(essential_urls) < 10:
        base_url = "https://alsworldwide.org/"
        main_pages = [
            base_url + "/",
            base_url + "/about/",
            base_url + "/what-is-als/",
            base_url + "/resources/",
            base_url + "/community/",
            base_url + "/research/",
            base_url + "/events/",
            base_url + "/news/",
            base_url + "/treatment/",
            base_url + "/care/",
            base_url + "/support/",
            base_url + "/advocacy/",
            base_url + "/faq/",
            base_url + "/volunteer/",
            base_url + "/contact-us/",
            base_url + "/contact/",
            base_url + "/donate/",
            base_url + "/staff/",
            base_url + "/board/",
        ]
        
        for page in main_pages:
            if page not in essential_urls:
                essential_urls.append(page)
    
    # Limit to a reasonable number (e.g., 30 pages)
    max_pages = 50
    if len(essential_urls) > max_pages:
        print(f"Limiting from {len(essential_urls)} to {max_pages} essential pages")
        return essential_urls[:max_pages]
    
    print(f"Selected {len(essential_urls)} essential pages to crawl")
    return essential_urls

if __name__ == "__main__":
    asyncio.run(main())