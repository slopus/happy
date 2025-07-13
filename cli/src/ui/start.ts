import { authGetToken, generateAppUrl, getOrCreateSecretKey } from '@/api/auth';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { displayQRCode } from '@/ui/qrcode';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startClaudeLoop } from '@/claude/loop';

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
  const response = await api.getOrCreateSession(sessionTag);
  logger.info(`Session created: ${response.session.id}`);

  // Generate and display QR code
  const handyUrl = generateAppUrl(secret);
  displayQRCode(handyUrl);

  // Create realtime session
  const session = api.session(response.session.id);

  // Create claude loop
  const loopDestroy = startClaudeLoop({ path: workingDirectory }, session);

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    await loopDestroy();
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