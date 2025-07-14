import { authGetToken, generateAppUrl } from '@/api/auth';
import { readSettings, writeSettings, readPrivateKey, writePrivateKey } from '@/persistence';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { displayQRCode } from '@/ui/qrcode';
import { basename } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { startClaudeLoop } from '@/claude/loop';
import os from 'node:os';
import { startPermissionServer } from '@/claude/mcp/startPermissionServer';
import chalk from 'chalk';
import { encodeBase64Url } from '@/api/encryption';

export interface StartOptions {
  model?: string
  permissionMode?: 'auto' | 'default' | 'plan'
}

export async function start(options: StartOptions = {}): Promise<void> {
  const workingDirectory = process.cwd();
  const projectName = basename(workingDirectory);
  const sessionTag = randomUUID();
  
  // Check onboarding
  const settings = await readSettings();
  const needsOnboarding = !settings || !settings.onboardingCompleted;
  
  if (needsOnboarding) {
    // Show onboarding
    logger.info('\n' + chalk.bold.green('🎉 Welcome to Happy CLI!'));
    logger.info('\nHappy is an open-source, end-to-end encrypted wrapper around Claude Code');
    logger.info('that allows you to start a regular Claude terminal session with the `happy` command.\n');
    
    if (process.platform === 'darwin') {
      logger.info(chalk.yellow('💡 Tip for macOS users:'));
      logger.info('   Install Amphetamine to prevent your Mac from sleeping during sessions:');
      logger.info('   https://apps.apple.com/us/app/amphetamine/id937984704?mt=12\n');
      logger.info('   You can even close your laptop completely while running Amphetamine');
      logger.info('   and connect through hotspot to your phone for coding on the go!\n');
    }
  }

  // Get or create secret key
  let secret = await readPrivateKey();
  if (!secret) {
    secret = new Uint8Array(randomBytes(32));
    await writePrivateKey(secret);
  }
  logger.info('Secret key loaded');

  // Authenticate with server
  const token = await authGetToken(secret);
  logger.info('Authenticated with handy server');

  // Create session service
  const api = new ApiClient(token, secret);

  // Create a new session
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata: { path: workingDirectory, host: os.hostname() } });
  logger.info(`Session created: ${response.session.id}`);

  // Show QR code during onboarding
  if (needsOnboarding) {
    const handyUrl = generateAppUrl(secret);
    displayQRCode(handyUrl);
    // Display secret for manual entry
    const secretBase64Url = encodeBase64Url(secret);
    logger.info(`Or manually enter this code: ${secretBase64Url}`);
    
    logger.info('\n' + chalk.bold('Press Enter to continue...'));
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve());
    });
    
    // Save onboarding completed
    await writeSettings({ onboardingCompleted: true });
  }

  // Create realtime session
  const session = api.session(response.session.id);

  // Start MCP permission server
  const permissionServer = await startPermissionServer((request) => {
    logger.info('Permission request:', request);
    // Send permission request to remote client
    session.sendMessage({
      type: 'permission-request',
      data: request
    });
  });
  logger.info(`MCP permission server started on port ${permissionServer.port}`);
  
  // Handle permission responses from remote client
  session.on('message', (message: any) => {
    if (message.type === 'permission-response') {
      logger.info('Permission response from client:', message.data);
      permissionServer.respondToPermission(message.data);
    }
  });

  // Create MCP configuration
  const mcpServers = {
    'permission-server': {
      type: 'http' as const,
      url: permissionServer.url,
    },
  };

  // Create claude loop
  let thinking = false;
  const loopDestroy = startClaudeLoop({ 
    path: workingDirectory, 
    model: options.model,
    permissionMode: options.permissionMode,
    mcpServers,
    permissionPromptToolName: permissionServer.toolName,
    onThinking: (t) => {
      thinking = t;
      session.keepAlive(t);
    } 
  }, session);

  // Set up periodic ping to keep connection alive
  const pingInterval = setInterval(() => {
    session.keepAlive(thinking);
  }, 15000); // Ping every 15 seconds

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    
    // Stop ping interval
    clearInterval(pingInterval);
    
    // Stop claude loop
    await loopDestroy();
    
    // Stop MCP permission server
    await permissionServer.stop();
    
    // Send session death message
    session.sendSessionDeath();
    
    // Wait for socket to flush
    await session.flush();
    
    // Close session
    await session.close();
    
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Started!
  logger.info('Happy CLI is starting...');

  // Keep process alive
  await new Promise(() => {
    // This promise never resolves, keeping the process running
  });
}