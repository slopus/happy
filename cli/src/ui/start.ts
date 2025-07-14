import { authGetToken, generateAppUrl, getOrCreateSecretKey } from '@/api/auth';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { displayQRCode } from '@/ui/qrcode';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startClaudeLoop } from '@/claude/loop';
import os from 'node:os';
import { startPermissionServer } from '@/claude/mcp/startPermissionServer';

export interface StartOptions {
  model?: string
  permissionMode?: 'auto' | 'default' | 'plan'
}

export async function start(options: StartOptions = {}): Promise<void> {
  const workingDirectory = process.cwd();
  const projectName = basename(workingDirectory);
  const sessionTag = randomUUID();
  logger.info(`Starting happy session for project: ${projectName}`);

  // Get or create secret key
  const secret = await getOrCreateSecretKey();
  logger.info('Secret key loaded');

  // Authenticate with server
  const token = await authGetToken(secret);
  logger.info('Authenticated with handy server');

  // Create session service
  const api = new ApiClient(token, secret);

  // Create a new session
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata: { path: workingDirectory, host: os.hostname() } });
  logger.info(`Session created: ${response.session.id}`);

  // Generate and display QR code
  const handyUrl = generateAppUrl(secret);
  displayQRCode(handyUrl);

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
  logger.info('Happy CLI is running. Press Ctrl+C to stop.');

  // Keep process alive
  await new Promise(() => {
    // This promise never resolves, keeping the process running
  });
}