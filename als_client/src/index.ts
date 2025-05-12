import { Scraper, SearchMode } from 'agent-twitter-client';
import { Cookie } from 'tough-cookie';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure server port
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Create Hono app
const app = new Hono();

const COOKIES_FILE = path.join(__dirname, 'twitter-cookies.json');
const PROCESSED_TWEETS_FILE = path.join(__dirname, 'processed-tweets.json');

// Keyword to search for
const SEARCH_KEYWORD = '@0xkeyaru';

// In-memory storage to replace file-based I/O
interface TweetData {
  id: string;
  username: string;
  content: string;
  timestamp: number;
  processed: boolean;
  response?: string;
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
    
    // Verify if login was successful
    const isLoggedIn = await scraper.isLoggedIn();
    
    if (isLoggedIn) {
      console.log('Successfully authenticated with cookies');
      const me = await scraper.me();
      console.log(`Logged in as: @${me?.username}`);
      return true;
    } else {
      console.log('Cookies are invalid or expired');
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

  try {
    console.log(`Logging in as ${username} with username/password...`);
    // Pass email and 2FA secret if available
    await scraper.login(username, password, email || undefined, twoFactorSecret || undefined);
    
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
    console.error('Authentication failed:', error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
    return false;
  }
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
    
    // Use fetchSearchTweets for more direct control
    const response = await scraper.fetchSearchTweets(SEARCH_KEYWORD, maxTweets, SearchMode.Latest);
    
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
        }
      }
    }
    
    console.log(`No new tweets found mentioning "${SEARCH_KEYWORD}"`);
    return null;
  } catch (error) {
    console.error('Error searching for tweets:', error);
    return null;
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
    const waitTimeMs = 120000; // 2 minutes (increased from 1 minute to give agent more time)
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
      // Prepare quote text - truncate if too long for a tweet
      const quoteText = tweet.response.substring(0, 240); // Twitter limit minus some room
      
      console.log(`Preparing to quote tweet @${tweet.username} with response`);
      console.log(`Quote text: "${quoteText.substring(0, 50)}..."`);
      
      // Send the quote tweet
      await scraper.sendQuoteTweet(quoteText, tweet.id);
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
  
  // Create a new scraper instance
  const scraper = new Scraper();
  
  // First try to authenticate with cookies
  let authenticated = await tryAuthWithCookies(scraper);
  
  // If cookie auth failed, try username/password
  if (!authenticated) {
    // If the cookie file exists but authentication failed, delete it
    if (fs.existsSync(COOKIES_FILE)) {
      console.log('Removing invalid cookie file');
      fs.unlinkSync(COOKIES_FILE);
    }
    
    authenticated = await loginWithCredentials(scraper);
  }
  
  if (!authenticated) {
    throw new Error('Failed to authenticate with Twitter');
  }
  
  return scraper;
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
    hasResponse: !!tweet.response
  }));
  
  return c.json({ tweets: tweetsArray });
});

/**
 * Main function to run the Twitter bot
 */
async function main() {
  try {
    // Load processed tweets from file
    loadProcessedTweets();
    
    // Initialize Twitter client
    const scraper = await initializeTwitterClient();
    
    console.log('Twitter Bot initialized successfully');
    console.log('Starting tweet processing cycle...');
    
    // Start the Hono server first so agent.py can connect
    serve({
      fetch: app.fetch,
      port: PORT
    });
    
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('API endpoints available for agent.py to connect');
    
    // Main processing loop
    const runProcessingCycle = async () => {
      try {
        // Skip processing if we already have an active tweet
        if (currentActiveTweet) {
          console.log(`Already processing tweet ${currentActiveTweet.id}, waiting for agent.py to respond`);
          return;
        }
        
        // Find latest tweet
        const latestTweet = await searchForLatestTweet(scraper);
        
        if (latestTweet) {
          // Process the tweet and send response
          await processTweetAndRespond(scraper, latestTweet);
        } else {
          console.log('No new tweets to process this cycle');
        }
      } catch (cycleError) {
        console.error('Error in processing cycle:', cycleError);
      } finally {
        // Schedule next run after 5 minutes
        setTimeout(runProcessingCycle, 5 * 60 * 1000);
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