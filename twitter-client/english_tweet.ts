import { Scraper, SearchMode, Tweet } from 'agent-twitter-client';
import { Cookie } from 'tough-cookie';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config();

const COOKIES_FILE = path.join(__dirname, 'twitter-cookies.json');
const INPUT_JSON_FILE = path.join(__dirname, '../input.json');
const OUTPUT_JSON_FILE = path.join(__dirname, '../output.json');

// Keyword to search for
const SEARCH_KEYWORD = '@0xkeyaru';

// Store found tweets to avoid duplicates
const processedTweets = new Set<string>();

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
 * Ensure the output directory exists
 */
function ensureDirectoriesExist(): void {
  const inputDir = path.dirname(INPUT_JSON_FILE);
  const outputDir = path.dirname(OUTPUT_JSON_FILE);
  
  if (!fs.existsSync(inputDir)) {
    fs.mkdirSync(inputDir, { recursive: true });
    console.log(`Created directory: ${inputDir}`);
  }
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Created directory: ${outputDir}`);
  }
}

/**
 * Write tweet content to input.json
 * @param content The tweet content to save
 */
function saveToInputJson(content: string): void {
  try {
    const inputData = {
      message: content,
      processed: false
    };
    
    fs.writeFileSync(INPUT_JSON_FILE, JSON.stringify(inputData, null, 2));
    console.log(`Saved tweet content to ${INPUT_JSON_FILE}`);
  } catch (error) {
    console.error('Error saving to input.json:', error);
  }
}

/**
 * Read the response from output.json
 * @returns The response content or null if not available
 */
function readFromOutputJson(): string | null {
  try {
    if (!fs.existsSync(OUTPUT_JSON_FILE)) {
      console.log(`${OUTPUT_JSON_FILE} does not exist yet`);
      return null;
    }
    
    const outputData = JSON.parse(fs.readFileSync(OUTPUT_JSON_FILE, 'utf8'));
    
    // Check if we have assistant messages in the output
    if (outputData && 
        outputData.messages && 
        Array.isArray(outputData.messages) &&
        outputData.messages.length >= 2) {
      
      // Find the assistant message - typically the second one if following user message
      const assistantMessage = outputData.messages.find((msg: { role: string }) => msg.role === 'assistant');      
      if (assistantMessage && assistantMessage.content) {
        console.log('Found assistant response in output.json');
        return assistantMessage.content;
      }
    }
    
    console.log('No valid assistant response found in output.json');
    return null;
  } catch (error) {
    console.error('Error reading from output.json:', error);
    return null;
  }
}

/**
 * Search for the latest tweet with specific keyword
 * @param scraper Authenticated Twitter scraper
 * @returns The latest tweet found or null
 */
async function searchForLatestTweet(scraper: Scraper): Promise<{username: string, content: string, tweetId: string} | null> {
  try {
    console.log(`Searching for tweets containing "${SEARCH_KEYWORD}"...`);
    
    // Set to get only the latest tweet
    const maxTweets = 1;
    let latestTweet: {username: string, content: string, tweetId: string} | null = null;
    
    console.log(`Starting search with mode: ${SearchMode.Latest} (${SearchMode[SearchMode.Latest]})`);
    
    // Use fetchSearchTweets for more direct control
    const response = await scraper.fetchSearchTweets(SEARCH_KEYWORD, maxTweets, SearchMode.Latest);
    
    // Get the most recent tweet that contains our keyword
    for (const tweet of response.tweets) {
      if (tweet.id && tweet.username && tweet.text && 
          tweet.text.toLowerCase().includes(SEARCH_KEYWORD.toLowerCase()) &&
          !processedTweets.has(tweet.id)) {
        
        console.log(`Found tweet by @${tweet.username}: "${tweet.text?.substring(0, 50)}..."`);
        
        latestTweet = {
          username: tweet.username,
          content: tweet.text,
          tweetId: tweet.id
        };
        
        // Mark this tweet as processed
        processedTweets.add(tweet.id);
        
        // Break after finding the first valid tweet
        break;
      }
    }
    
    if (!latestTweet) {
      console.log(`No new tweets found mentioning "${SEARCH_KEYWORD}"`);
    }
    
    return latestTweet;
  } catch (error) {
    console.error('Error searching for tweets:', error);
    return null;
  }
}

/**
 * Process a tweet by saving its content to input.json,
 * waiting for processing, and then retweeting with the response
 * @param scraper Authenticated Twitter scraper
 * @param tweet The tweet to process
 */
async function processTweetAndRespond(scraper: Scraper, tweet: {username: string, content: string, tweetId: string}): Promise<void> {
  try {
    // Save the tweet content to input.json
    saveToInputJson(tweet.content);
    
    // Wait for 1 minute (60000 ms) for processing
    console.log(`Waiting 1 minute for processing...`);
    await new Promise(resolve => setTimeout(resolve, 60000));
    
    // Read the response from output.json
    const responseContent = readFromOutputJson();
    
    if (!responseContent) {
      console.log('No response content found in output.json, skipping retweet');
      return;
    }
    
    // Prepare quote text - truncate if too long for a tweet
    const quoteText = responseContent.substring(0, 240); // Twitter limit minus some room
    
    console.log(`Preparing to quote tweet @${tweet.username} with response`);
    console.log(`Quote text: "${quoteText.substring(0, 50)}..."`);
    
    // Send the quote tweet
    await scraper.sendQuoteTweet(quoteText, tweet.tweetId);
    console.log('Quote tweet sent successfully!');
    
    // Refresh cookies after successful operation
    await saveCookies(scraper);
  } catch (error) {
    console.error('Error processing tweet:', error);
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
 * Main function to run the Twitter bot
 */
async function main() {
  try {
    // Ensure directories exist
    ensureDirectoriesExist();
    
    // Initialize Twitter client
    const scraper = await initializeTwitterClient();
    
    console.log('Twitter Bot initialized successfully');
    console.log('Starting tweet processing cycle...');
    
    // Main processing loop
    const runProcessingCycle = async () => {
      try {
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
      }
      
      // Schedule next run after 5 minutes
      setTimeout(runProcessingCycle, 5 * 60 * 1000);
    };
    
    // Start the first cycle
    await runProcessingCycle();
    
    console.log('Bot is now running... Press Ctrl+C to stop');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the main function
main();