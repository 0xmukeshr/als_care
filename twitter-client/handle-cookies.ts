import { Scraper, SearchMode } from 'agent-twitter-client';
import { Cookie } from 'tough-cookie';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config();

const COOKIES_FILE = path.join(__dirname, 'twitter-cookies.json');

// Keywords related to ALS to search for
const SEARCH_KEYWORDS = [
  'ALS',
  'Amyotrophic lateral sclerosis',
  'motor neuron disease',
  'Lou Gehrig\'s disease'
];

// Store found tweets to avoid duplicates
const processedTweets = new Set<string>();
const tweetQueue: {username: string, content: string, tweetId: string}[] = [];

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
    
    // Save new cookies for future use
    await saveCookies(scraper);
    
    return true;
  } catch (error) {
    console.error('Authentication failed:', error);
    return false;
  }
}

/**
 * Search for tweets with specific keywords
 * @param scraper Authenticated Twitter scraper
 */
async function searchForALSTweets(scraper: Scraper): Promise<void> {
  try {
    console.log('Searching for ALS related tweets...');
    
    // Build search query with all keywords (using OR operator)
    const searchQuery = SEARCH_KEYWORDS.map(keyword => `"${keyword}"`).join(' OR ');
    
    // Only fetch the latest tweets (not top tweets)
    let tweetCount = 0;
    const maxTweets = 20; // Limit to avoid rate limiting
    
    const tweetIterator = scraper.searchTweets(searchQuery, maxTweets, SearchMode.Latest);
    
    for await (const tweet of tweetIterator) {
      if (tweet.id && !processedTweets.has(tweet.id)) {
        tweetCount++;
        processedTweets.add(tweet.id);
        
        // Add to queue for potential sharing
        if (tweet.username && tweet.text) {
          tweetQueue.push({
            username: tweet.username,
            content: tweet.text,
            tweetId: tweet.id
          });
          
          console.log(`Found new tweet by @${tweet.username}: "${tweet.text?.substring(0, 50)}..."`);
        }
      }
      
      // Avoid processing too many tweets at once
      if (tweetCount >= maxTweets) {
        break;
      }
    }
    
    console.log(`Found ${tweetCount} new tweets about ALS`);
    
    // Keep the tweet queue manageable (keep only the latest 50)
    if (tweetQueue.length > 50) {
      tweetQueue.splice(0, tweetQueue.length - 50);
    }
  } catch (error) {
    console.error('Error searching for tweets:', error);
  }
}

/**
 * Send a tweet with the latest ALS content
 * @param scraper Authenticated Twitter scraper
 */
async function sendALSTweet(scraper: Scraper): Promise<void> {
  try {
    if (tweetQueue.length === 0) {
      console.log('No ALS tweets in queue to share, skipping this round');
      return;
    }
    
    // Get the most recent tweet from queue
    const tweetToShare = tweetQueue.pop();
    
    if (!tweetToShare) {
      return;
    }
    
    // Format the tweet content
    const tweetContent = `RT @${tweetToShare.username}: ${tweetToShare.content.substring(0, 180)}... #ALS #ALSResearch`;
    
    console.log(`Sending tweet: "${tweetContent.substring(0, 50)}..."`);
    await scraper.sendTweet(tweetContent);
    
    console.log('Tweet sent successfully!');
    
    // Refresh cookies after successful operation
    await saveCookies(scraper);
  } catch (error) {
    console.error('Error sending tweet:', error);
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

/**
 * Main function to run the Twitter ALS bot
 */
async function main() {
  try {
    // Initialize Twitter client
    const scraper = await initializeTwitterClient();
    
    console.log('ALS Twitter Bot initialized successfully');
    console.log('Starting search and tweet cycles...');
    
    // Schedule search for ALS tweets every 2 minutes
    setInterval(() => {
      searchForALSTweets(scraper).catch(error => {
        console.error('Error in search cycle:', error);
      });
    }, 2 * 60 * 1000); // 2 minutes
    
    // Schedule sending tweets every 5 minutes
    setInterval(() => {
      sendALSTweet(scraper).catch(error => {
        console.error('Error in tweet cycle:', error);
      });
    }, 5 * 60 * 1000); // 5 minutes
    
    // Initial run immediately
    await searchForALSTweets(scraper);
    
    // Wait a bit before first tweet
    setTimeout(() => {
      sendALSTweet(scraper).catch(error => {
        console.error('Error in initial tweet:', error);
      });
    }, 30 * 1000); // 30 seconds after startup
    
    console.log('Bot is now running... Press Ctrl+C to stop');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the main function
main();