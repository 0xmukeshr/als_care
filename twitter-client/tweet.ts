import { Scraper } from 'agent-twitter-client';
import { Cookie } from 'tough-cookie';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config();

const COOKIES_FILE = path.join(__dirname, 'twitter-cookies.json');

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
 * Main function to run the Twitter client
 */
async function main() {
  try {
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
    
    
    // Send a tweet
    const tweetContent = process.env.TWEET_CONTENT || 'GM GUYS';
    console.log(`Sending tweet: "${tweetContent}"`);
    const tweetResult = await scraper.sendTweet(tweetContent);
    
    console.log('Tweet sent successfully!');
    
    // Display tweet information
    if (tweetResult && typeof tweetResult === 'object') {
      console.log('Tweet response received:', tweetResult.status);
      
      
      // You can try to get the tweet ID from the response, but this depends on the actual response structure
      // Check the response to see what properties are available
      console.log('Response data:', tweetResult);
    }
    
    // Refresh cookies after successful operation
    await saveCookies(scraper);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}
main();