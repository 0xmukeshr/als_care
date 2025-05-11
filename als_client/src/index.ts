import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Scraper, SearchMode } from 'agent-twitter-client';
import { Cookie } from 'tough-cookie';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';

// Load environment variables from .env file
dotenv.config();

// Create a new Hono app
const app = new Hono();

// Define port for the server
const PORT = process.env.PORT || 3000;

// Store found tweets to avoid duplicates and track processing status
const processedTweets = new Set();
const pendingTweets = {};

// In-memory response storage instead of using files
const botResponses = {};

// Store cookies in memory
let twitterCookies = [];

// Path to the cookies file
const COOKIES_FILE_PATH = path.join(process.cwd(), './cookies.json');

/**
 * Try to load cookies from file
 * @returns Array of loaded cookies or empty array if failed
 */
async function loadCookiesFromFile() {
  try {
    console.log(`Attempting to load cookies from ${COOKIES_FILE_PATH}`);
    const fileExists = await fs.access(COOKIES_FILE_PATH)
      .then(() => true)
      .catch(() => false);
    
    if (!fileExists) {
      console.log('Cookies file not found');
      return [];
    }
    
    const cookiesData = await fs.readFile(COOKIES_FILE_PATH, 'utf-8');
    const cookiesJson = JSON.parse(cookiesData);
    const cookies = cookiesJson.map(cookieJson => Cookie.fromJSON(cookieJson)).filter((cookie): cookie is Cookie => cookie !== null);

    console.log(`Loaded ${cookies.length} cookies from file`);
    
    return cookies;
  } catch (error) {
    console.error('Error loading cookies from file:', error);
    return [];
  }
}

/**
 * Save Twitter cookies to memory and file
 * @param scraper The scraper instance to get cookies from
 */
async function saveCookies(scraper) {
  try {
    // Get cookies directly from the scraper
    twitterCookies = await scraper.getCookies();
    console.log('Cookies saved successfully to memory');
    
    // Also save to file for persistence
    await fs.writeFile(COOKIES_FILE_PATH, JSON.stringify(twitterCookies, null, 2));
    console.log(`Cookies saved to ${COOKIES_FILE_PATH}`);
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
    if (!existsSync(COOKIES_FILE_PATH)) {
      console.log('No saved cookies found');
      return false;
    }
    
    const cookiesData = await fs.readFile(COOKIES_FILE_PATH, 'utf8');
    const cookiesJson = await JSON.parse(cookiesData);
    
    if (!Array.isArray(cookiesJson) || cookiesJson.length === 0) {
      console.log('Invalid cookie data, will login with credentials');
      return false;
    }
    
    console.log('Attempting to authenticate with saved cookies...');
    
    // Convert JSON objects back to Cookie objects
    try {
      const cookies = await cookiesJson.map(cookieJson => Cookie.fromJSON(cookieJson)).filter((cookie): cookie is Cookie => cookie !== null);
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
async function loginWithCredentials(scraper) {
  // Get authentication details from environment variables
  const username = process.env.TWITTER_USERNAME;
  const password = process.env.TWITTER_PASSWORD;
  const email = process.env.TWITTER_EMAIL; // Optional
  const twoFactorSecret = process.env.TWITTER_2FA_SECRET; // Optional

  if (!username || !password) {
    console.warn('Twitter credentials not found in environment variables');
    return false; // Changed to return false instead of throwing error
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
 * @param keyword Keyword to search for
 * @returns The latest tweet found or null
 */
async function searchForLatestTweet(scraper, keyword) {
  try {
    console.log(`Searching for tweets containing "${keyword}"...`);
    
    // Set to get only the latest tweet
    const maxTweets = 1;
    let latestTweet = null;
    
    console.log(`Starting search with mode: ${SearchMode.Latest} (${SearchMode[SearchMode.Latest]})`);
    
    // Use fetchSearchTweets for more direct control
    const response = await scraper.fetchSearchTweets(keyword, maxTweets, SearchMode.Latest);
    console.log("RESPONSE FROM TWITTER",response)
    // Get the most recent tweet that contains our keyword
    for (const tweet of response.tweets) {
      if (tweet.id && tweet.username && tweet.text && 
          tweet.text.toLowerCase().includes(keyword.toLowerCase()) &&
          !processedTweets.has(tweet.id)) {
        
        console.log(`Found tweet by @${tweet.username}: "${tweet.text?.substring(0, 50)}..."`);
        
        latestTweet = {
          username: tweet.username,
          content: tweet.text,
          tweetId: tweet.id
        };
        
        // Mark this tweet as processed
        processedTweets.add(tweet.id);
        
        // Add to pending tweets
        pendingTweets[tweet.id] = {
          ...latestTweet,
          timestamp: Date.now()
        };
        
        // Break after finding the first valid tweet
        break;
      }
    }
    
    if (!latestTweet) {
      console.log(`No new tweets found mentioning "${keyword}"`);
    }
    
    return latestTweet;
  } catch (error) {
    console.error('Error searching for tweets:', error);
    return null;
  }
}

/**
 * Send a response to a tweet
 * @param scraper Authenticated Twitter scraper
 * @param tweetId The tweet ID to respond to
 * @param response The response content
 */
async function respondToTweet(scraper, tweetId, response) {
  try {
    // if (!pendingTweets[tweetId]) {
    //   console.log(`Tweet ${tweetId} not found in pending tweets`);
    //   return false;
    // }
    
    // Prepare quote text - truncate if too long for a tweet
    const quoteText = response.substring(0, 240); // Twitter limit minus some room
    
    // console.log(`Preparing to quote tweet @${pendingTweets[tweetId].username} with response`);
    console.log(`Quote text: "${quoteText.substring(0, 50)}...for ${tweetId}"`);
    
    // Send the quote tweet
    await scraper.sendQuoteTweet(quoteText, tweetId);
    console.log('Quote tweet sent successfully!');
    
    // Store the response
    botResponses[tweetId] = response;
    
    // Remove from pending
    delete pendingTweets[tweetId];
    
    // Refresh cookies after successful operation
    await saveCookies(scraper);
    
    return true;
  } catch (error) {
    console.error('Error sending response tweet:', error);
    return false;
  }
}

// Create a scraper instance to use across the application
let scraperInstance = null;

/**
 * Initialize the Twitter client
 */
async function initializeTwitterClient() {
  if (scraperInstance) {
    return scraperInstance;
  }
  
  console.log('Initializing Twitter client...');
  
  // Create a new scraper instance
  const scraper = new Scraper();
  
  // First try to authenticate with cookies
  let authenticated = await tryAuthWithCookies(scraper);
  
  // If cookie auth failed, try username/password
  if (!authenticated) {
    authenticated = await loginWithCredentials(scraper);
  }
  
  if (!authenticated) {
    throw new Error('Failed to authenticate with Twitter - check cookies.json file or provide credentials in .env');
  }
  
  scraperInstance = scraper;
  return scraper;
}

// Middleware to check if Twitter client is initialized
async function ensureTwitterClient(c, next) {
  if (!scraperInstance) {
    try {
      await initializeTwitterClient();
    } catch (error) {
      return c.json({ error: `Failed to initialize Twitter client: ${error.message}` }, 500);
    }
  }
  return next();
}

// API Routes
app.get('/', (c) => {
  return c.text('Twitter Bot API is running');
});

// Get status of the Twitter client
app.get('/api/status', async (c) => {
  try {
    const isInitialized = !!scraperInstance;
    let isLoggedIn = false;
    let username = null;
    
    if (isInitialized) {
      isLoggedIn = await scraperInstance.isLoggedIn() || false;
      if (isLoggedIn) {
        const me = await scraperInstance.me();
        username = me?.username;
      }
    }
    
    // Check if cookies file exists
    const cookiesFileExists = await fs.access(COOKIES_FILE_PATH)
      .then(() => true)
      .catch(() => false);
    
    return c.json({
      status: 'ok',
      isInitialized,
      isLoggedIn,
      username,
      pendingTweets: Object.keys(pendingTweets).length,
      processedTweets: processedTweets.size,
      cookiesFileExists
    });
  } catch (error) {
    return c.json({ error: 'Error fetching status' }, 500);
  }
});

// Endpoint to initialize/refresh Twitter client
app.post('/api/init', async (c) => {
  try {
    scraperInstance = null; // Force re-initialization
    const scraper = await initializeTwitterClient();
    const me = await scraper.me();
    
    return c.json({
      success: true,
      username: me?.username
    });
  } catch (error) {
    console.error('Initialization error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Endpoint to search for tweets with keyword
app.get('/api/search', ensureTwitterClient, async (c) => {
  try {
    const keyword = c.req.query('keyword') || '';
    
    if (!keyword) {
      return c.json({ error: 'Keyword parameter is required' }, 400);
    }
    
    const tweet = await searchForLatestTweet(scraperInstance, keyword);
    
    return c.json({
      success: true,
      tweet: tweet || null
    });
  } catch (error) {
    console.error('Search error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Endpoint to get pending tweets
app.get('/api/pending-tweets', ensureTwitterClient, (c) => {
  return c.json({
    success: true,
    pendingTweets: Object.values(pendingTweets)
  });
});

// Endpoint to submit a response to a tweet
app.post('/api/respond', ensureTwitterClient, async (c) => {
  try {
    const body = await c.req.json();
    const { tweetId, response } = await body;
    
    if (!tweetId || !response) {
      return c.json({ error: 'tweetId and response are required' }, 400);
    }
    
    // if (!pendingTweets[tweetId]) {
    //   return c.json({ error: 'Tweet not found in pending tweets' }, 404);
    // }
    
    const success = await respondToTweet(scraperInstance, tweetId, response);
    
    
    return c.json({
      success,
      tweetId,
      responded: success
    });
  } catch (error) {
    console.error('Response error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Endpoint to get responses
app.get('/api/responses', ensureTwitterClient, (c) => {
  return c.json({
    success: true,
    responses: botResponses
  });
});

// Background task to search for tweets periodically
async function startBackgroundTask(searchKeyword) {
  console.log(`Starting background task to search for tweets with keyword: "${searchKeyword}"`);
  
  const runSearch = async () => {
    try {
      if (!scraperInstance) {
        await initializeTwitterClient();
      }
      
      await searchForLatestTweet(scraperInstance, searchKeyword);
      
      // Clean up old pending tweets (older than 30 minutes)
      const now = Date.now();
      Object.keys(pendingTweets).forEach(id => {
        if (now - pendingTweets[id].timestamp > 30 * 60 * 1000) {
          delete pendingTweets[id];
        }
      });
      
    } catch (error) {
      console.error('Error in background search task:', error);
    }
    
    // Schedule next run after 5 minutes
    setTimeout(runSearch, 5 * 60 * 1000);
  };
  
  // Start the first run
  runSearch();
}

// Main function
async function main() {
  try {
    // Initialize Twitter client on startup
    await initializeTwitterClient();
    
    // Get search keyword from environment variable or use default
    const searchKeyword = process.env.SEARCH_KEYWORD || '';
    
    // Start background task if keyword is provided
    if (searchKeyword) {
      startBackgroundTask(searchKeyword);
    }
    
    // Start the server
    console.log(`Starting server on port ${PORT}...`);
    serve({
      fetch: app.fetch,
      port: Number(PORT)
    });
    
    console.log(`Server is running on http://localhost:${PORT}`);
  } catch (error) {
    console.error('Fatal error:', error);
    // Don't exit process on initialization failure, allow manual retry via API
    console.log('Server will continue running to allow initialization via API');
    
    // Start the server anyway
    console.log(`Starting server on port ${PORT}...`);
    serve({
      fetch: app.fetch,
      port: Number(PORT)
    });
    
    console.log(`Server is running on http://localhost:${PORT}`);
  }
}

// Run the main function
main();