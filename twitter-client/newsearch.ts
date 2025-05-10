import { Scraper, SearchMode, Tweet } from 'agent-twitter-client';
import { Cookie } from 'tough-cookie';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Constants
const COOKIES_FILE = path.join(__dirname, 'twitter-cookies.json');
const SEARCH_KEYWORD = '@adgpi'; // Replace with your desired keyword

/**
 * Simple program to login to Twitter with cookies and search for tweets
 */
async function main() {
  try {
    console.log('Starting Twitter search program...');
    
    // Initialize Twitter scraper
    const scraper = new Scraper();
    console.log('Twitter scraper initialized');
    
    // Try to authenticate with cookies first
    let authenticated = await tryAuthWithCookies(scraper);
    
    // If cookie auth failed, try username/password
    if (!authenticated) {
      console.log('Cookie authentication failed, trying username/password...');
      authenticated = await loginWithCredentials(scraper);
      
      if (authenticated) {
        // Save cookies for future use
        await saveCookies(scraper);
      }
    }
    
    if (!authenticated) {
      throw new Error('Authentication failed');
    }
    
    console.log('Authentication successful!');
    
    // Get user info to confirm login
    const me = await scraper.me();
    console.log(`Logged in as: @${me?.username}`);
    
    // Search for tweets with keyword
    console.log(`\nSearching for tweets with keyword: ${SEARCH_KEYWORD}`);
    await searchTweets(scraper, SEARCH_KEYWORD);
    
    console.log('\nSearch completed');
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

/**
 * Try to authenticate with saved cookies
 * @param scraper The Twitter scraper
 * @returns Whether authentication was successful
 */
async function tryAuthWithCookies(scraper: Scraper): Promise<boolean> {
  try {
    console.log('Attempting to authenticate with cookies...');
    
    if (!fs.existsSync(COOKIES_FILE)) {
      console.log('No cookie file found');
      return false;
    }
    
    const cookiesData = fs.readFileSync(COOKIES_FILE, 'utf8');
    const cookiesJson = JSON.parse(cookiesData);
    
    if (!Array.isArray(cookiesJson) || cookiesJson.length === 0) {
      console.log('Invalid cookie data');
      return false;
    }
    
    // Convert JSON to Cookie objects
    const cookies = cookiesJson
      .map(cookieJson => Cookie.fromJSON(cookieJson))
      .filter((cookie): cookie is Cookie => cookie !== null);
    
    if (cookies.length === 0) {
      console.log('No valid cookies found');
      return false;
    }
    
    // Set cookies in the scraper
    await scraper.setCookies(cookies);
    
    // Check if login was successful
    const isLoggedIn = await scraper.isLoggedIn();
    
    if (isLoggedIn) {
      console.log('Successfully authenticated with cookies');
      return true;
    } else {
      console.log('Cookie authentication failed');
      return false;
    }
  } catch (error) {
    console.error('Error during cookie authentication:', error);
    return false;
  }
}

/**
 * Authenticate with Twitter using username/password
 * @param scraper The Twitter scraper
 * @returns Whether authentication was successful
 */
async function loginWithCredentials(scraper: Scraper): Promise<boolean> {
  try {
    // Get credentials from environment variables
    const username = process.env.TWITTER_USERNAME;
    const password = process.env.TWITTER_PASSWORD;
    const email = process.env.TWITTER_EMAIL; // Optional
    const twoFactorSecret = process.env.TWITTER_2FA_SECRET; // Optional
    
    if (!username || !password) {
      throw new Error('Twitter credentials not found in environment variables');
    }
    
    console.log(`Logging in as ${username}...`);
    
    // Attempt login
    await scraper.login(username, password, email, twoFactorSecret);
    
    // Verify login
    const isLoggedIn = await scraper.isLoggedIn();
    
    if (isLoggedIn) {
      console.log('Successfully logged in with credentials');
      return true;
    } else {
      console.log('Credential authentication failed');
      return false;
    }
  } catch (error) {
    console.error('Error during credential authentication:', error);
    return false;
  }
}

/**
 * Save Twitter cookies to file for future use
 * @param scraper The Twitter scraper
 */
async function saveCookies(scraper: Scraper): Promise<void> {
  try {
    console.log('Saving cookies...');
    
    // Get current cookies
    const cookies = await scraper.getCookies();
    
    // Convert to serializable format
    const serializedCookies = cookies.map(cookie => cookie.toJSON());
    
    // Save to file
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(serializedCookies, null, 2));
    
    console.log('Cookies saved successfully');
  } catch (error) {
    console.error('Error saving cookies:', error);
  }
}

/**
 * Search for tweets with keyword
 * @param scraper The Twitter scraper
 * @param keyword The keyword to search for
 */
async function searchTweets(scraper: Scraper, keyword: string): Promise<void> {
  try {
    // Number of tweets to search for
    const maxTweets = 10;
    
    console.log(`Searching for up to ${maxTweets} tweets with keyword: ${keyword}`);
    console.log('Using search mode: Latest');
    
    // Counter for found tweets
    let count = 0;


    
    // Use the searchTweets method which returns an AsyncGenerator
    for await (const tweet of scraper.searchTweets(keyword, maxTweets, SearchMode.Latest)) {
      count++;
      
      // Display tweet information
      console.log(`\nTweet #${count}:`);
      console.log(`ID: ${tweet.id}`);
      console.log(`Username: @${tweet.username}`);
      console.log(`Posted at: ${tweet.timestamp ?? 'Unknown'}`);
      console.log(`Content: ${tweet.text?.substring(0, 100)}${tweet.text && tweet.text.length > 100 ? '...' : ''}`);
      

      // Display engagement metrics if available
      if (tweet.likes !== undefined || tweet.retweets !== undefined || tweet.replies !== undefined) {
        console.log('Engagement:');
        if (tweet.likes !== undefined) console.log(`- Likes: ${tweet.likes}`);
        if (tweet.retweets !== undefined) console.log(`- Retweets: ${tweet.retweets}`);
        if (tweet.replies !== undefined) console.log(`- Replies: ${tweet.replies}`);
      }
      
      console.log('---');
    }
    
    console.log(`\nFound ${count} tweets matching "${keyword}"`);
    
  } catch (error) {
    console.error('Error searching for tweets:', error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
  }
}
// Run the program
main();