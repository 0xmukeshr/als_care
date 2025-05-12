import { Scraper, SearchMode } from 'agent-twitter-client';
import { Cookie } from 'tough-cookie';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'url';
import OpenAI from 'openai'; // Import OpenAI

// Load environment variables from .env file
dotenv.config();

let scraper=new Scraper();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure server port
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Create Hono app
const app = new Hono();

const COOKIES_FILE = path.join(__dirname, 'twitter-cookies.json');
const PROCESSED_TWEETS_FILE = path.join(__dirname, 'processed-tweets.json');

// Keyword to search for
const SEARCH_KEYWORD = '@alsassist_ai';

// In-memory storage to replace file-based I/O
interface TweetData {
  id: string;
  username: string;
  content: string;
  timestamp: number;
  processed: boolean;
  response?: string;
  refinedResponse?: string;
}

// In-memory storage
const tweetStore: Map<string, TweetData> = new Map();
let currentActiveTweet: TweetData | null = null;
// Set to keep track of processed tweet IDs
const processedTweetIds: Set<string> = new Set();

/**
 * Load processed tweet IDs from file
 */
function loadProcessedTweets(): void {
  try {
    if (fs.existsSync(PROCESSED_TWEETS_FILE)) {
      const data = fs.readFileSync(PROCESSED_TWEETS_FILE, 'utf8');
      const ids = JSON.parse(data);
      
      if (Array.isArray(ids)) {
        ids.forEach(id => processedTweetIds.add(id));
        console.log(`Loaded ${processedTweetIds.size} processed tweet IDs from file`);
      }
    }
  } catch (error) {
    console.error('Error loading processed tweets:', error);
    // Continue with empty set if file doesn't exist or is invalid
  }
}

/**
 * Save processed tweet IDs to file
 */
function saveProcessedTweets(): void {
  try {
    const ids = Array.from(processedTweetIds);
    fs.writeFileSync(PROCESSED_TWEETS_FILE, JSON.stringify(ids, null, 2));
    console.log(`Saved ${ids.length} processed tweet IDs to file`);
  } catch (error) {
    console.error('Error saving processed tweets:', error);
  }
}

/**
 * Save Twitter cookies to a file
 * @param scraper The scraper instance to get cookies from
 */
async function saveCookies(scraper: Scraper): Promise<void> {
  try {
    // Get cookies directly from the scraper
    const cookies = await scraper.getCookies();
    
    // Save them as serializable objects
    const serializedCookies = cookies.map(cookie => cookie.toJSON());
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(serializedCookies, null, 2));
    console.log('Cookies saved successfully');
  } catch (error) {
    console.error('Error saving cookies:', error);
  }
}

/**
 * Try to authenticate with saved cookies
 * @param scraper Twitter scraper instance
 * @returns Whether authentication was successful
 */
async function tryAuthWithCookies(scraper: Scraper): Promise<boolean> {
  try {
    if (!fs.existsSync(COOKIES_FILE)) {
      console.log('No saved cookies found');
      return false;
    }
    
    const cookiesData = fs.readFileSync(COOKIES_FILE, 'utf8');
    const cookiesJson = JSON.parse(cookiesData);
    
    if (!Array.isArray(cookiesJson) || cookiesJson.length === 0) {
      console.log('Invalid cookie data, will login with credentials');
      return false;
    }
    
    console.log('Attempting to authenticate with saved cookies...');
    
    // Convert JSON objects back to Cookie objects
    try {
      const cookies = cookiesJson.map(cookieJson => Cookie.fromJSON(cookieJson)).filter((cookie): cookie is Cookie => cookie !== null);
      
      await scraper.setCookies(cookies);
    } catch (error) {
      console.log('Error setting cookies:', error);
      return false;
    }
    
    // Verify if login was successful with a timeout
    try {
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error('isLoggedIn check timed out after 15 seconds')), 15000);
      });
      
      const loginCheckPromise = scraper.isLoggedIn();
      const isLoggedIn = await Promise.race([loginCheckPromise, timeoutPromise]);
      
      if (isLoggedIn) {
        console.log('Successfully authenticated with cookies');
        try {
          const meCheckPromise = scraper.me();
          const meTimeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('User info check timed out')), 15000);
          });
          
          const me = await Promise.race([meCheckPromise, meTimeoutPromise]);
          if (me) {
            console.log(`Logged in as: @${me.username}`);
          }
        } catch (profileError) {
          console.log('Could not fetch user profile, but login appears successful');
        }
        return true;
      } else {
        console.log('Cookies are invalid or expired');
        return false;
      }
    } catch (error) {
      console.error('Error checking login status:', error);
      return false;
    }
  } catch (error) {
    console.error('Error during cookie authentication:', error);
    return false;
  }
}

/**
 * Authenticate with Twitter using username/password
 * @param scraper Twitter scraper instance
 * @returns Whether authentication was successful
 */
async function loginWithCredentials(scraper: Scraper): Promise<boolean> {
  // Get authentication details from environment variables
  const username = process.env.TWITTER_USERNAME;
  const password = process.env.TWITTER_PASSWORD;
  const email = process.env.TWITTER_EMAIL; // Optional
  const twoFactorSecret = process.env.TWITTER_2FA_SECRET; // Optional

  if (!username || !password) {
    throw new Error('Twitter credentials not found in environment variables');
  }

  const maxRetries = 3;
  let retries = 0;
  let lastError: any = null;

  while (retries < maxRetries) {
    try {
      if (retries > 0) {
        console.log(`Retry attempt ${retries}/${maxRetries} for login...`);
        // Exponential backoff
        const delay = Math.pow(2, retries) * 1000;
        console.log(`Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      console.log(`Logging in as ${username} with username/password...`);
      
      // Configure a timeout for the login attempt
      const loginPromise = scraper.login(username, password, email || undefined, twoFactorSecret || undefined);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Login timed out after 30 seconds')), 30000);
      });
      
      // Use Promise.race to implement a timeout
      await Promise.race([loginPromise, timeoutPromise]);
      
      const isLoggedIn = await scraper.isLoggedIn();
      if (!isLoggedIn) {
        throw new Error('Failed to log in to Twitter with username/password');
      }
      
      console.log('Successfully logged in with username/password');
      const me = await scraper.me();
      console.log(`Logged in as: @${me?.username}`);
      
      // Save new cookies for future use
      await saveCookies(scraper);
      
      return true;
    } catch (error) {
      lastError = error;
      console.error(`Authentication attempt ${retries + 1} failed:`, error);
      
      if (error instanceof Error) {
        console.error(error.stack);
        
        // Check if this is a network error that might resolve with a retry
        const errorMessage = error.message.toLowerCase();
        const errorStack = error.stack?.toLowerCase() || '';
        
        if (
          errorMessage.includes('etimedout') || 
          errorMessage.includes('network') ||
          errorMessage.includes('timeout') ||
          errorStack.includes('etimedout') ||
          errorStack.includes('fetch failed')
        ) {
          console.log('Network-related error detected, will retry');
          retries++;
          continue;
        } else {
          // Non-network error, no point in retrying
          console.log('Non-network error, not retrying');
          break;
        }
      }
      
      retries++;
    }
  }
  
  console.error(`Failed authentication after ${maxRetries} attempts`);
  if (lastError) {
    console.error('Last error:', lastError);
  }
  return false;
}

/**
 * Search for the latest tweet with specific keyword
 * @param scraper Authenticated Twitter scraper
 * @returns The latest tweet found or null
 */
async function searchForLatestTweet(scraper: Scraper): Promise<TweetData | null> {
  try {
    console.log(`Searching for tweets containing "${SEARCH_KEYWORD}"...`);
    
    // Set to get only the latest tweet
    const maxTweets = 10; // Increased to find more potential new tweets
    
    console.log(`Starting search with mode: ${SearchMode.Latest} (${SearchMode[SearchMode.Latest]})`);
    
    // Implement timeout for the search request
    const searchPromise = scraper.fetchSearchTweets(SEARCH_KEYWORD, maxTweets, SearchMode.Latest);
    const timeoutPromise = new Promise<any>((_, reject) => {
      setTimeout(() => reject(new Error('Search request timed out after 45 seconds')), 45000);
    });
    
    const response = await Promise.race([searchPromise, timeoutPromise]);
    
    if (!response || !response.tweets || !Array.isArray(response.tweets)) {
      console.log('Invalid or empty response from search');
      return null;
    }
    
    console.log(`Retrieved ${response.tweets.length} tweets from search`);
    
    // Get the most recent tweet that contains our keyword and hasn't been processed
    for (const tweet of response.tweets) {
      if (tweet.id && tweet.username && tweet.text && 
          tweet.text.toLowerCase().includes(SEARCH_KEYWORD.toLowerCase()) &&
          !processedTweetIds.has(tweet.id)) {
        
        console.log(`Found new tweet by @${tweet.username}: "${tweet.text?.substring(0, 50)}..."`);
        
        const tweetData: TweetData = {
          id: tweet.id,
          username: tweet.username,
          content: tweet.text,
          timestamp: Date.now(),
          processed: false
        };
        
        // Store the tweet in our memory store
        tweetStore.set(tweet.id, tweetData);
        
        return tweetData;
      } else if (tweet.id) {
        if (processedTweetIds.has(tweet.id)) {
          console.log(`Skipping already processed tweet ID: ${tweet.id}`);
        } else if (!tweet.text?.toLowerCase().includes(SEARCH_KEYWORD.toLowerCase())) {
          console.log(`Tweet ${tweet.id} doesn't contain the keyword`);
        }
      }
    }
    
    console.log(`No new tweets found mentioning "${SEARCH_KEYWORD}"`);
    return null;
  } catch (error) {
    console.error('Error searching for tweets:', error);
    if (error instanceof Error) {
      console.error(error.stack);
      
      // Check if this is a network error
      if (
        error.message.includes('timeout') || 
        error.message.includes('etimedout') ||
        error.message.includes('network') ||
        error.message.includes('fetch failed')
      ) {
        console.log('Network-related error during search, will retry in the next cycle');
      }
    }
    return null;
  }
}

/**
 * Process response text through OpenAI to optimize for Twitter
 * @param responseText The original response text
 * @param tweetContent The content of the original tweet
 * @returns Optimized response text for Twitter
 */
async function optimizeForTwitter(responseText: string, tweetContent: string): Promise<string> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log('OpenAI API key not found, using original response');
      return responseText;
    }
    
    console.log('Processing response through OpenAI...');
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that refines text to be perfect for Twitter. Optimize the text to be engaging, concise, and within Twitter's 280 character limit. Keep the core message but make it more conversational, impactful, and shareable. Add hashtags only if appropriate."
        },
        {
          role: "user",
          content: `Original tweet: "${tweetContent}"\n\nMy response to optimize for Twitter (make it brief, engaging, and under 280 characters): "${responseText}"`
        }
      ],
      max_tokens: 150
    });
    
    const optimizedResponse = completion.choices[0].message.content?.trim();
    
    if (!optimizedResponse) {
      console.log('No optimized response received from OpenAI, using original');
      return responseText;
    }
    
    console.log('OpenAI optimized the response for Twitter');
    
    // Make sure it's under Twitter's limit (280 characters)
    return optimizedResponse.substring(0, 280);
    
  } catch (error) {
    console.error('Error optimizing response with OpenAI:', error);
    // Fallback to original response if OpenAI processing fails
    return responseText.substring(0, 280);
  }
}

/**
 * Process a tweet and respond with the AI-generated content
 * @param scraper Authenticated Twitter scraper
 * @param tweet The tweet to process
 */
async function processTweetAndRespond(scraper: Scraper, tweet: TweetData): Promise<void> {
  try {
    // Set as the current active tweet for API access
    currentActiveTweet = tweet;
    console.log(`Set tweet ${tweet.id} as current active tweet for agent.py to process`);
    
    // Wait for the agent.py to process the tweet and provide a response
    const waitTimeMs = 60000; // 1 minute
    console.log(`Waiting up to ${waitTimeMs/1000} seconds for agent.py to provide a response...`);
    
    // Set a timeout to check for response
    await new Promise<void>((resolve) => {
      const checkInterval = 5000; // Check every 5 seconds
      let elapsedTime = 0;
      
      const intervalId = setInterval(() => {
        elapsedTime += checkInterval;
        
        // Check if we have a response for this tweet
        if (tweet.response) {
          clearInterval(intervalId);
          resolve();
          return;
        }
        
        // If we've waited long enough without a response, move on
        if (elapsedTime >= waitTimeMs) {
          clearInterval(intervalId);
          console.log('No response received within the time limit');
          resolve();
        }
      }, checkInterval);
    });
    
    // If we got a response, send the quote tweet
    if (tweet.response) {
      // Optimize the response for Twitter using OpenAI
      const optimizedResponse = await optimizeForTwitter(tweet.response, tweet.content);
      tweet.refinedResponse = optimizedResponse;
      
      console.log(`Preparing to quote tweet @${tweet.username} with optimized response`);
      console.log(`Original: "${tweet.response.substring(0, 100)}..."`);
      console.log(`Optimized: "${optimizedResponse}"`);
      
      // Send the quote tweet with optimized response
      await scraper.sendQuoteTweet(optimizedResponse, tweet.id);
      console.log('Quote tweet sent successfully!');
      
      // Mark as processed
      tweet.processed = true;
      
      // Add to processed tweets set
      processedTweetIds.add(tweet.id);
      saveProcessedTweets();
      
      // Refresh cookies after successful operation
      await saveCookies(scraper);
    } else {
      console.log(`No response received for tweet ${tweet.id}, marking as processed to avoid repeat`);
      // Still mark as processed to avoid repeated processing
      processedTweetIds.add(tweet.id);
      saveProcessedTweets();
    }
    
    // Clear the current active tweet regardless of outcome
    if (currentActiveTweet?.id === tweet.id) {
      currentActiveTweet = null;
    }
  } catch (error) {
    console.error('Error processing tweet:', error);
    
    // Mark as processed even on error to avoid repeated failures
    processedTweetIds.add(tweet.id);
    saveProcessedTweets();
    
    // Clear the current active tweet on error
    if (currentActiveTweet?.id === tweet.id) {
      currentActiveTweet = null;
    }
  }
}

/**
 * Initialize the Twitter client
 */
async function initializeTwitterClient(): Promise<Scraper> {
  console.log('Initializing Twitter client...');
  
  // Configure proxy if available
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxyUrl) {
    console.log(`Using proxy: ${proxyUrl}`);
    // Note: You may need to enhance the Scraper class to accept proxy settings
    // This is a placeholder for potential proxy implementation
  }
  
  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      if (retryCount > 0) {
        console.log(`Retry attempt ${retryCount}/${maxRetries} for Twitter client initialization...`);
        await new Promise(resolve => setTimeout(resolve, retryCount * 2000)); // Increasing delay between retries
      }
      
      // Create a new scraper instance
      const scraper = new Scraper({
        timeout: 30000, // 30 seconds timeout for network requests
        retry: 2 // Built-in retry for individual requests
      });
      
      // First try to authenticate with cookies
      let authenticated = await tryAuthWithCookies(scraper);
      
      // If cookie auth failed, try username/password
      if (!authenticated) {
        // If the cookie file exists but authentication failed, delete it
        if (fs.existsSync(COOKIES_FILE)) {
          console.log('Removing invalid cookie file');
          try {
            fs.unlinkSync(COOKIES_FILE);
          } catch (unlinkError) {
            console.error('Error removing cookie file:', unlinkError);
          }
        }
        
        authenticated = await loginWithCredentials(scraper);
      }
      
      if (!authenticated) {
        throw new Error('Failed to authenticate with Twitter');
      }
      
      console.log('Twitter client initialized successfully');
      return scraper;
    } catch (error) {
      console.error(`Initialization attempt ${retryCount + 1} failed:`, error);
      
      // Check if this is a network-related error that might be resolved with a retry
      const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
      const errorStack = error instanceof Error ? (error.stack?.toLowerCase() || '') : '';
      
      const isNetworkError = 
        errorMessage.includes('etimedout') || 
        errorMessage.includes('network') ||
        errorMessage.includes('fetch failed') ||
        errorMessage.includes('timeout') ||
        errorStack.includes('etimedout') ||
        errorStack.includes('fetch failed');
      
      if (isNetworkError && retryCount < maxRetries - 1) {
        console.log('Network error detected, will retry initialization');
        retryCount++;
      } else if (retryCount < maxRetries - 1) {
        console.log('Will retry Twitter client initialization');
        retryCount++;
      } else {
        throw new Error(`Failed to initialize Twitter client after ${maxRetries} attempts: ${errorMessage}`);
      }
    }
  }
  
  throw new Error('Failed to initialize Twitter client after maximum retries');
}

// Define API routes

// GET endpoint to fetch the current active tweet that needs processing
app.get('/api/current-tweet', (c) => {
  if (!currentActiveTweet) {
    return c.json({ status: 'no_active_tweet' }, 404);
  }
  
  return c.json({
    status: 'active',
    tweet: {
      id: currentActiveTweet.id,
      username: currentActiveTweet.username,
      content: currentActiveTweet.content
    }
  });
});

// POST endpoint to receive AI-generated response
app.post('/api/tweet-response', async (c) => {
  try {
    const body = await c.req.json();
    
    // Validate request body
    if (!body.tweetId || !body.response) {
      return c.json({ status: 'error', message: 'Missing tweetId or response' }, 400);
    }
    
    const tweetId = body.tweetId;
    const response = body.response;
    
    // Check if the tweet exists in our store
    const tweet = tweetStore.get(tweetId);
    if (!tweet) {
      return c.json({ status: 'error', message: 'Tweet not found' }, 404);
    }
    
    // Store the response
    tweet.response = response;
    console.log(`Received response for tweet ${tweetId}`);
    
    return c.json({ status: 'success' });
  } catch (error) {
    console.error('Error processing response:', error);
    return c.json({ status: 'error', message: 'Internal server error' }, 500);
  }
});

// GET endpoint to check server status
app.get('/api/status', (c) => {
  return c.json({
    status: 'online',
    tweetCount: tweetStore.size,
    processedTweetCount: processedTweetIds.size,
    hasActiveTweet: currentActiveTweet !== null
  });
});

// GET endpoint to view processed tweets
app.get('/api/tweets', (c) => {
  const tweetsArray = Array.from(tweetStore.values()).map(tweet => ({
    id: tweet.id,
    username: tweet.username,
    content: tweet.content.substring(0, 100) + (tweet.content.length > 100 ? '...' : ''),
    timestamp: tweet.timestamp,
    processed: tweet.processed || processedTweetIds.has(tweet.id),
    hasResponse: !!tweet.response,
    refinedResponse: tweet.refinedResponse || null
  }));
  
  return c.json({ tweets: tweetsArray });
});

/**
 * Main function to run the Twitter bot
 */
async function main() {
  try {
    // Check if OpenAI API key is configured
    if (!process.env.OPENAI_API_KEY) {
      console.warn('OPENAI_API_KEY not found in environment variables. Response optimization will be skipped.');
    } else {
      console.log('OpenAI integration ready for response optimization');
    }
    
    // Check networking configuration
    console.log('Checking network configuration...');
    if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
      console.log(`Proxy detected: ${process.env.HTTP_PROXY || process.env.HTTPS_PROXY}`);
    }
    
    try {
      // Simple connectivity test - attempt a DNS lookup
      const dns = await import('dns');
      const startTime = Date.now();
      await new Promise<void>((resolve, reject) => {
        dns.lookup('twitter.com', (err) => {
          if (err) {
            console.error('Network connectivity issue detected!');
            console.error('Could not resolve twitter.com:', err.message);
            // Continue anyway, as the retry logic should handle this
          } else {
            const elapsed = Date.now() - startTime;
            console.log(`Network connectivity test passed (${elapsed}ms to resolve twitter.com)`);
          }
          resolve();
        });
      });
    } catch (netError) {
      console.warn('Network configuration check failed:', netError);
      // Continue anyway
    }
    
    // Load processed tweets from file
    loadProcessedTweets();
    
    // Start the Hono server first so agent.py can connect
    console.log(`Starting server on http://localhost:${PORT}`);
    serve({
      fetch: app.fetch,
      port: PORT
    });
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('API endpoints available for agent.py to connect');
    
    let scraper: Scraper | null = null;
    let initializationSuccess = false;
    const maxInitRetries = 5;
    
    // Try to initialize Twitter client with retries
    for (let i = 0; i < maxInitRetries; i++) {
      try {
        console.log(`Twitter client initialization attempt ${i+1}/${maxInitRetries}`);
        if (i > 0) {
          // Wait for increasingly longer periods between retries
          const delay = Math.pow(2, i) * 1000;
          console.log(`Waiting ${delay/1000} seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Initialize Twitter client
        scraper = await initializeTwitterClient();
        initializationSuccess = true;
        console.log('Twitter Bot initialized successfully');
        break;
      } catch (initError) {
        console.error(`Initialization attempt ${i+1} failed:`, initError);
        if (i === maxInitRetries - 1) {
          throw new Error(`Failed to initialize Twitter client after ${maxInitRetries} attempts`);
        }
      }
    }
    
    if (!initializationSuccess || !scraper) {
      throw new Error('Twitter client initialization failed');
    }
    
    console.log('Starting tweet processing cycle...');
    
    // Main processing loop
    const runProcessingCycle = async () => {
      try {
        // Skip processing if we already have an active tweet
        if (currentActiveTweet) {
          console.log(`Already processing tweet ${currentActiveTweet.id}, waiting for agent.py to respond`);
          return;
        }
        
        // Check if scraper is still authenticated
        let isAuthenticated = false;
        try {
          isAuthenticated = await Promise.race([
            scraper.isLoggedIn(),
            new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('Login check timed out')), 15000))
          ]);
        } catch (authCheckError) {
          console.error('Error checking authentication status:', authCheckError);
          isAuthenticated = false;
        }
        
        // Re-authenticate if needed
        if (!isAuthenticated) {
          console.log('Twitter session expired, re-authenticating...');
          try {
            scraper = await initializeTwitterClient();
          } catch (reAuthError) {
            console.error('Re-authentication failed:', reAuthError);
            // Skip this cycle, will try again next time
            return;
          }
        }
        
        // Find latest tweet
        let latestTweet = null;
        try {
          latestTweet = await searchForLatestTweet(scraper);
        } catch (searchError) {
          console.error('Error searching for tweets:', searchError);
          // Skip processing this cycle
          return;
        }
        
        if (latestTweet) {
          // Process the tweet and send response
          await processTweetAndRespond(scraper, latestTweet);
        } else {
          console.log('No new tweets to process this cycle');
        }
      } catch (cycleError) {
        console.error('Error in processing cycle:', cycleError);
      } finally {
        // Schedule next run after 3 minutes
        setTimeout(runProcessingCycle, 3 * 60 * 1000);
      }
    };
    
    // Start the first cycle
    runProcessingCycle();
    
    console.log('Bot is now running... Press Ctrl+C to stop');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the main function
main();