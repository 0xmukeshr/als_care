import { Scraper, SearchMode } from 'agent-twitter-client';
import { Cookie } from 'tough-cookie';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

dotenv.config();

const scraper = new Scraper();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = new Hono();

const COOKIES_FILE = path.join(__dirname, 'twitter-cookies.json');
const PROCESSED_TWEETS_FILE = path.join(__dirname, 'processed-tweets.json');

const SEARCH_KEYWORD = '@alsassist_ai';

interface TweetData {
  id: string;
  username: string;
  content: string;
  timestamp: number;
  processed: boolean;
  response?: string;
  refinedResponse?: string;
  dmSent?: boolean;
}

const tweetStore: Map<string, TweetData> = new Map();
let currentActiveTweet: TweetData | null = null;
const processedTweetIds: Set<string> = new Set();

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
  }
}

function saveProcessedTweets(): void {
  try {
    const ids = Array.from(processedTweetIds);
    fs.writeFileSync(PROCESSED_TWEETS_FILE, JSON.stringify(ids, null, 2));
    console.log(`Saved ${ids.length} processed tweet IDs to file`);
  } catch (error) {
    console.error('Error saving processed tweets:', error);
  }
}

async function saveCookies(scraper: Scraper): Promise<void> {
  try {
    const cookies = await scraper.getCookies();
    const serializedCookies = cookies.map(cookie => cookie.toJSON());
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(serializedCookies, null, 2));
    console.log('Cookies saved successfully');
  } catch (error) {
    console.error('Error saving cookies:', error);
  }
}

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
    
    try {
      const cookies = cookiesJson.map(cookieJson => Cookie.fromJSON(cookieJson)).filter((cookie): cookie is Cookie => cookie !== null);
      await scraper.setCookies(cookies);
    } catch (error) {
      console.log('Error setting cookies:', error);
      return false;
    }
    
    try {
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error('isLoggedIn check timed out after 15 seconds')), 15000);
      });
      
      const loginCheckPromise = scraper.isLoggedIn();
      const isLoggedIn = await Promise.race([loginCheckPromise, timeoutPromise]);
      
      if (isLoggedIn) {
        console.log('Successfully authenticated with cookies');
        try {
          const me = await Promise.race([
            scraper.me(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('User info check timed out')), 15000))
          ]);
          if (me && typeof me === 'object' && 'username' in me) {
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

async function loginWithCredentials(scraper: Scraper): Promise<boolean> {
  const username = process.env.TWITTER_USERNAME;
  const password = process.env.TWITTER_PASSWORD;
  const email = process.env.TWITTER_EMAIL;
  const twoFactorSecret = process.env.TWITTER_2FA_SECRET;

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
        const delay = Math.pow(2, retries) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      console.log(`Logging in as ${username} with username/password...`);
      
      const loginPromise = scraper.login(username, password, email || undefined, twoFactorSecret || undefined);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Login timed out after 30 seconds')), 30000);
      });
      
      await Promise.race([loginPromise, timeoutPromise]);
      
      const isLoggedIn = await scraper.isLoggedIn();
      if (!isLoggedIn) {
        throw new Error('Failed to log in to Twitter with username/password');
      }
      
      console.log('Successfully logged in with username/password');
      const me = await scraper.me();
      console.log(`Logged in as: @${me?.username}`);
      
      await saveCookies(scraper);
      
      return true;
    } catch (error) {
      lastError = error;
      console.error(`Authentication attempt ${retries + 1} failed:`, error);
      
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        const errorStack = error.stack?.toLowerCase() || '';
        
        if (
          errorMessage.includes('etimedout') || 
          errorMessage.includes('network') ||
          errorMessage.includes('timeout') ||
          errorStack.includes('etimedout') ||
          errorStack.includes('fetch failed')
        ) {
          retries++;
          continue;
        } else {
          break;
        }
      }
      
      retries++;
    }
  }
  
  console.error(`Failed authentication after ${maxRetries} attempts`);
  return false;
}

async function getBotUsername(scraper: Scraper): Promise<string | null> {
  try {
    const me = await scraper.me();
    if (me && typeof me === 'object' && 'username' in me && me.username) {
      return me.username.toLowerCase();
    }
    return null;
  } catch (error) {
    console.error('Error fetching bot username:', error);
    return process.env.TWITTER_USERNAME?.toLowerCase() || null;
  }
}

async function searchForLatestTweet(scraper: Scraper): Promise<TweetData | null> {
  try {
    console.log(`Searching for tweets containing "${SEARCH_KEYWORD}"...`);
    
    const botUsername = await getBotUsername(scraper);
    console.log(`Bot username identified as: ${botUsername || 'unknown'}`);
    
    const maxTweets = 20;
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
    
    for (const tweet of response.tweets) {
      if (!tweet.id || !tweet.username || !tweet.text) {
        continue;
      }
      
      if (botUsername && tweet.username.toLowerCase() === botUsername) {
        console.log(`Skipping our own tweet from @${tweet.username}`);
        continue;
      }
      
      if (tweet.text.toLowerCase().includes(SEARCH_KEYWORD.toLowerCase()) && !processedTweetIds.has(tweet.id)) {
        console.log(`Found new tweet by @${tweet.username}: "${tweet.text?.substring(0, 50)}..."`);
        
        const tweetData: TweetData = {
          id: tweet.id,
          username: tweet.username,
          content: tweet.text,
          timestamp: Date.now(),
          processed: false
        };
        
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
    
    console.log(`No new tweets found mentioning "${SEARCH_KEYWORD}" (excluding our own)`);
    return null;
  } catch (error) {
    console.error('Error searching for tweets:', error);
    return null;
  }
}

async function optimizeForTwitter(responseText: string, tweetContent: string): Promise<string> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log('OpenAI API key not found, using original response');
      return responseText;
    }
    
    console.log('Processing response through OpenAI...');
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that refines text to be perfect for Twitter. Optimize the text to be engaging, concise, and within Twitter's 250 character limit. Keep the core message but make it more conversational, impactful, and shareable. Add hashtags only if appropriate."
        },
        {
          role: "user",
          content: `My response to optimize for Twitter (make it brief, engaging, and under 230 characters): "${responseText}"`
        }
      ],
      max_tokens: 230
    });
    
    const optimizedResponse = completion.choices[0].message.content?.trim();
    
    if (!optimizedResponse) {
      console.log('No optimized response received from OpenAI, using original');
      return responseText;
    }
    
    console.log('OpenAI optimized the response for Twitter');
    return optimizedResponse.substring(0, 250);
    
  } catch (error) {
    console.error('Error optimizing response with OpenAI:', error);
    return responseText.substring(0, 250);
  }
}

async function sendDirectMessage(scraper: Scraper, username: string, messageText: string): Promise<boolean> {
  try {
    console.log(`Preparing to send DM to user @${username}`);
    
    const conversations = await scraper.getDirectMessageConversations(username);
    
    if (!conversations || !conversations.conversations) {
      console.log(`Could not fetch conversations for @${username}`);
      return false;
    }
    
    let conversationId: string | null = null;
    for (const entry of conversations.conversations) {
      if (entry.participants && entry.participants.some(p => p.screenName.toLowerCase() === username.toLowerCase())) {        
        conversationId = entry.conversationId;
        break;
      }
    }
    
    if (!conversationId) {
      console.log(`No existing conversation found with @${username}, trying to create a new one`);
      
      try {
        const newConversation = await scraper.getDirectMessageConversations(username);
        if (newConversation && newConversation.conversations?.[0]?.conversationId) {
          conversationId = newConversation.conversations[0].conversationId;
          console.log(`Created new conversation with @${username}, ID: ${conversationId}`);
        } else {
          console.log(`Failed to create new conversation with @${username}`);
          return false;
        }
      } catch (createError) {
        console.error(`Error creating conversation with @${username}:`, createError);
        return false;
      }
    }
    
    if (!conversationId) {
      console.log(`Still no conversation ID for @${username}, cannot send DM`);
      return false;
    }
    
    console.log(`Sending DM to @${username} with conversation ID: ${conversationId}`);
    const response = await scraper.sendDirectMessage(conversationId, messageText);
    
    if (response) {
      console.log(`Successfully sent DM to @${username}`);
      return true;
    } else {
      console.log(`Failed to send DM to @${username}`);
      return false;
    }
  } catch (error) {
    console.error(`Error sending DM to @${username}:`, error);
    return false;
  }
}

async function processTweetAndRespond(scraper: Scraper, tweet: TweetData): Promise<void> {
  try {
    currentActiveTweet = tweet;
    console.log(`Set tweet ${tweet.id} as current active tweet for agent.py to process`);
    
    const waitTimeMs = 60000;
    console.log(`Waiting up to ${waitTimeMs/1000} seconds for agent.py to provide a response...`);
    
    await new Promise<void>((resolve) => {
      const checkInterval = 5000;
      let elapsedTime = 0;
      
      const intervalId = setInterval(() => {
        elapsedTime += checkInterval;
        
        if (tweet.response) {
          clearInterval(intervalId);
          resolve();
          return;
        }
        
        if (elapsedTime >= waitTimeMs) {
          clearInterval(intervalId);
          console.log('No response received within the time limit');
          resolve();
        }
      }, checkInterval);
    });
    
    if (tweet.response) {
      const optimizedResponse = await optimizeForTwitter(tweet.response, tweet.content);
      tweet.refinedResponse = optimizedResponse;
      
      console.log(`Preparing to respond to @${tweet.username}`);
      console.log(`Original: "${tweet.response.substring(0, 100)}..."`);
      console.log(`Optimized: "${optimizedResponse}"`);
      
      const dmSent = await sendDirectMessage(scraper, tweet.username, 
        `Hi there! Here's my response to your tweet that mentioned ${SEARCH_KEYWORD}:\n\n${tweet.response}\n\nI'll also post a shorter version as a public reply.`);
      
      tweet.dmSent = dmSent;
      if (dmSent) {
        console.log(`Successfully sent detailed response as DM to @${tweet.username}`);
      } else {
        console.log(`Could not send DM to @${tweet.username}, proceeding with public reply only`);
      }
      
      const quoteTweetContent = `${optimizedResponse}`;
      
      await scraper.sendQuoteTweet(quoteTweetContent.substring(0, 280), tweet.id);
      console.log('Quote tweet sent successfully!');
      
      tweet.processed = true;
      processedTweetIds.add(tweet.id);
      saveProcessedTweets();
      
      await saveCookies(scraper);
    } else {
      console.log(`No response received for tweet ${tweet.id}, marking as processed to avoid repeat`);
      processedTweetIds.add(tweet.id);
      saveProcessedTweets();
    }
    
    if (currentActiveTweet?.id === tweet.id) {
      currentActiveTweet = null;
    }
  } catch (error) {
    console.error('Error processing tweet:', error);
    processedTweetIds.add(tweet.id);
    saveProcessedTweets();
    
    if (currentActiveTweet?.id === tweet.id) {
      currentActiveTweet = null;
    }
  }
}

async function initializeTwitterClient(): Promise<Scraper> {
  console.log('Initializing Twitter client...');
  
  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      if (retryCount > 0) {
        console.log(`Retry attempt ${retryCount}/${maxRetries} for Twitter client initialization...`);
        await new Promise(resolve => setTimeout(resolve, retryCount * 2000));
      }
      
      const scraper = new Scraper();
      
      let authenticated = await tryAuthWithCookies(scraper);
      
      if (!authenticated) {
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
      
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        const errorStack = error.stack?.toLowerCase() || '';
        
        const isNetworkError = 
          errorMessage.includes('etimedout') || 
          errorMessage.includes('network') ||
          errorMessage.includes('fetch failed') ||
          errorMessage.includes('timeout') ||
          errorStack.includes('etimedout') ||
          errorStack.includes('fetch failed');
        
        if (isNetworkError && retryCount < maxRetries - 1) {
          retryCount++;
        } else if (retryCount < maxRetries - 1) {
          retryCount++;
        } else {
          throw new Error(`Failed to initialize Twitter client after ${maxRetries} attempts`);
        }
      } else {
        retryCount++;
      }
    }
  }
  
  throw new Error('Failed to initialize Twitter client after maximum retries');
}

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

app.post('/api/tweet-response', async (c) => {
  try {
    const body = await c.req.json();
    
    if (!body.tweetId || !body.response) {
      return c.json({ status: 'error', message: 'Missing tweetId or response' }, 400);
    }
    
    const tweetId = body.tweetId;
    const response = body.response;
    
    const tweet = tweetStore.get(tweetId);
    if (!tweet) {
      return c.json({ status: 'error', message: 'Tweet not found' }, 404);
    }
    
    tweet.response = response;
    console.log(`Received response for tweet ${tweetId}`);
    
    return c.json({ status: 'success' });
  } catch (error) {
    console.error('Error processing response:', error);
    return c.json({ status: 'error', message: 'Internal server error' }, 500);
  }
});

app.get('/api/status', (c) => {
  return c.json({
    status: 'online',
    tweetCount: tweetStore.size,
    processedTweetCount: processedTweetIds.size,
    hasActiveTweet: currentActiveTweet !== null
  });
});

app.get('/api/tweets', (c) => {
  const tweetsArray = Array.from(tweetStore.values()).map(tweet => ({
    id: tweet.id,
    username: tweet.username,
    content: tweet.content.substring(0, 100) + (tweet.content.length > 100 ? '...' : ''),
    timestamp: tweet.timestamp,
    processed: tweet.processed || processedTweetIds.has(tweet.id),
    hasResponse: !!tweet.response,
    refinedResponse: tweet.refinedResponse || null,
    dmSent: tweet.dmSent || false
  }));
  
  return c.json({ tweets: tweetsArray });
});

async function main() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn('OPENAI_API_KEY not found in environment variables. Response optimization will be skipped.');
    } else {
      console.log('OpenAI integration ready for response optimization');
    }
    
    loadProcessedTweets();
    
    console.log(`Starting server on http://localhost:${PORT}`);
    serve({
      fetch: app.fetch,
      port: PORT
    });
    console.log(`Server running on http://localhost:${PORT}`);
    
    let scraper: Scraper | null = null;
    const maxInitRetries = 5;
    
    for (let i = 0; i < maxInitRetries; i++) {
      try {
        console.log(`Twitter client initialization attempt ${i+1}/${maxInitRetries}`);
        if (i > 0) {
          const delay = Math.pow(2, i) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        scraper = await initializeTwitterClient();
        console.log('Twitter Bot initialized successfully');
        break;
      } catch (initError) {
        console.error(`Initialization attempt ${i+1} failed:`, initError);
        if (i === maxInitRetries - 1) {
          throw new Error(`Failed to initialize Twitter client after ${maxInitRetries} attempts`);
        }
      }
    }
    
    if (!scraper) {
      throw new Error('Twitter client initialization failed');
    }
    
    console.log('Starting tweet processing cycle...');
    
    const runProcessingCycle = async () => {
      try {
        if (currentActiveTweet) {
          console.log(`Already processing tweet ${currentActiveTweet.id}, waiting for agent.py to respond`);
          return;
        }
        
        let isAuthenticated = false;
        try {
          isAuthenticated = await Promise.race([
            scraper!.isLoggedIn(),
            new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('Login check timed out')), 15000))
          ]);
        } catch (authCheckError) {
          console.error('Error checking authentication status:', authCheckError);
          isAuthenticated = false;
        }
        
        if (!isAuthenticated) {
          console.log('Twitter session expired, re-authenticating...');
          try {
            scraper = await initializeTwitterClient();
          } catch (reAuthError) {
            console.error('Re-authentication failed:', reAuthError);
            return;
          }
        }
        
        const latestTweet = await searchForLatestTweet(scraper!);
        
        if (latestTweet) {
          await processTweetAndRespond(scraper!, latestTweet);
        } else {
          console.log('No new tweets to process this cycle');
        }
      } catch (cycleError) {
        console.error('Error in processing cycle:', cycleError);
      } finally {
        setTimeout(runProcessingCycle, 3 * 60 * 1000);
      }
    };
    
    runProcessingCycle();
    
    console.log('Bot is now running... Press Ctrl+C to stop');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();