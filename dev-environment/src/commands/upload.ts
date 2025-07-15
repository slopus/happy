import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import { homedir } from 'os';
import * as os from 'os';
import * as readline from 'node:readline';
import { randomUUID } from 'crypto';
import { Logger } from '@/ui/logger.js';
import { ApiClient } from '@/api/api.js';
import { authGetToken } from '@/api/auth.js';
import { decodeBase64Url } from '@/api/encryption.js';

  const logger = new Logger('console');

async function loadSecret(keyBase64?: string): Promise<Uint8Array> {
  if (keyBase64) {
    return decodeBase64Url(keyBase64);
  }

  const keyPath = join(homedir(), '.handy', 'access.key');

  if (existsSync(keyPath)) {
    const keyBase64 = readFileSync(keyPath, 'utf8').trim();
    return new Uint8Array(Buffer.from(keyBase64, 'base64'));
  }

  logger.error('No secret key found. Please provide a key using --key or ensure ~/.handy/access.key exists.');
  process.exit(1);
}

// Helper function to prompt user for confirmation
function promptUser(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(`${message} (Y/n): `, (answer) => {
      rl.close();
      const trimmedAnswer = answer.trim().toLowerCase();
      // Default to yes if empty (just pressed Enter)
      resolve(trimmedAnswer === '' || trimmedAnswer === 'y' || trimmedAnswer === 'yes');
    });
  });
}

// Helper function to delay execution
function delay(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

export const uploadCommand = new Command('upload')
  .description('Upload a JSONL file to a session')
  .argument('<filepath>', 'Path to the JSONL file to upload')
  .option('-k, --key <key>', 'Base64 encoded secret key')
  .option('-i, --interactive', 'Prompt before sending each message')
  .option('-d, --delay <seconds>', 'Delay between messages in seconds', '0')
  .option('-n, --new-session', 'Generate a new random session ID instead of using filename')
  .action(async (filepath: string, options: { key?: string; interactive?: boolean; delay?: string; newSession?: boolean }) => {
    try {
      // Validate file exists and is a .jsonl file
      if (!existsSync(filepath)) {
        logger.error(`File does not exist: ${filepath}`);
        process.exit(1);
      }
      // Create API client (token would need to be passed or loaded from config)
      logger.info(`File exists: ${filepath}`);

      const fileExt = extname(filepath);
      if (fileExt !== '.jsonl' && fileExt !== '.json') {
        logger.error(`File must be a .jsonl or .json file: ${filepath}`);
        process.exit(1);
      }

      // Parse delay option
      const delaySeconds = parseFloat(options.delay || '0');
      if (isNaN(delaySeconds) || delaySeconds < 0) {
        logger.error('Delay must be a non-negative number');
        process.exit(1);
      }

      // Extract session ID from filename or generate a new one
      const sessionTag = options.newSession ? randomUUID() : basename(filepath, '.jsonl');
      
      if (options.newSession) {
        logger.info(`Using new random session ID: ${sessionTag}`);
      } else {
        logger.info(`Using filename-based session ID: ${sessionTag}`);
      }
      
      // Get working directory
      const workingDirectory = process.cwd();

      // Load secret key
      const secret = await loadSecret(options.key);
      const token = await authGetToken(secret);

      const api = new ApiClient(token, secret);

      // Create a new session
      const response = await api.getOrCreateSession({ 
        tag: sessionTag, 
        metadata: { path: workingDirectory, host: os.hostname() } 
      });
      logger.info(`Session created: ${response.session.id}`);

      // Create realtime session
      const session = api.session(response.session.id);
      
      let thinking = false;

      // Set up periodic ping to keep connection alive
      const pingInterval = setInterval(() => {
        session.keepAlive(thinking);
      }, 15000); // Ping every 15 seconds

      // Handle graceful shutdown
      const shutdown = async () => {
        logger.info('Shutting down...')
        
        // Stop ping interval
        clearInterval(pingInterval);

        // Send session death message
        session.sendSessionDeath();
        
        // Wait for socket to flush
        await session.flush();
        
        // Close session
        await session.close();
        
        process.exit(0);
      };

      // Handle shutdown signals
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Read and process JSONL file
      const fileContent = readFileSync(filepath, 'utf8');
      
      let messages: any[];
      
      if (fileExt === '.jsonl') {
        // Process JSONL file (existing behavior)
        const lines = fileContent.trim().split('\n');
        messages = [];
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              messages.push(message);
            } catch (error) {
              logger.error(`Failed to parse JSONL line: ${line}`, error);
              process.exit(1);
            }
          }
        }
      } else {
        // Process JSON file (expected to be an array)
        try {
          const parsed = JSON.parse(fileContent);
          if (!Array.isArray(parsed)) {
            logger.error('JSON file must contain an array of messages');
            process.exit(1);
          }
          messages = parsed;
        } catch (error) {
          logger.error('Failed to parse JSON file:', error);
          process.exit(1);
        }
      }

      logger.info(`Processing ${messages.length} messages from ${filepath}`);

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        
        try {
          // Interactive mode: prompt before sending
          if (options.interactive) {
            const preview = JSON.stringify(message).substring(0, 100) + (JSON.stringify(message).length > 100 ? '...' : '');
            logger.info(`Message ${i + 1}/${messages.length}: ${preview}`);
            
            const shouldSend = await promptUser('Send this message?');
            if (!shouldSend) {
              logger.info('Skipping message');
              continue;
            }
          }
          
          session.sendMessage({
              data: message,
              type: 'output',
          });
          logger.debug(`Sent message ${i + 1}/${messages.length}: ${JSON.stringify(message).substring(0, 100)}${JSON.stringify(message).length > 100 ? '...' : ''}`);
          
          // Apply delay if specified (but not after the last message)
          if (delaySeconds > 0 && i < messages.length - 1) {
            logger.info(`Waiting ${delaySeconds} seconds before next message...`);
            await delay(delaySeconds);
          }
          
        } catch (error) {
          logger.error(`Failed to send message ${i + 1}:`, error);
        }
      }

      logger.info('All messages sent successfully');
      
      // Wait a bit for messages to be processed, then shutdown
      setTimeout(shutdown, 2000);

    } catch (error) {
      logger.error('Upload failed:', error);
      process.exit(1);
    }
  });