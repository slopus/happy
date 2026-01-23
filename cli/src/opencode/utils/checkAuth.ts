/**
 * OpenCode Authentication Utilities
 * 
 * Utilities for checking OpenCode CLI authentication status.
 */

import { execSync, spawnSync } from 'node:child_process';
import { logger } from '@/ui/logger';

/**
 * Check if OpenCode CLI is installed
 * @returns true if opencode command is available
 */
export function isOpencodeInstalled(): boolean {
  try {
    const result = spawnSync('which', ['opencode'], { 
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if OpenCode is authenticated by running `opencode auth list`
 * @returns true if at least one provider is authenticated
 */
export async function isOpencodeAuthenticated(): Promise<boolean> {
  try {
    // First check if opencode is installed
    if (!isOpencodeInstalled()) {
      logger.debug('[OpenCode] Not installed');
      return false;
    }

    // Run opencode auth list to check for configured providers
    const result = spawnSync('opencode', ['auth', 'list'], { 
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    if (result.status !== 0) {
      logger.debug('[OpenCode] Auth list command failed:', result.stderr);
      return false;
    }

    const output = result.stdout.trim();
    
    // Check if output indicates any providers are configured
    // Empty output or "No providers" means not authenticated
    if (!output || 
        output.includes('No providers') || 
        output.includes('not authenticated') ||
        output.includes('No authenticated')) {
      logger.debug('[OpenCode] Not authenticated - no providers configured');
      return false;
    }
    
    logger.debug('[OpenCode] Authenticated - found providers');
    return true;
  } catch (error) {
    logger.debug('[OpenCode] Auth check failed:', error);
    return false;
  }
}

/**
 * Display message prompting user to authenticate with OpenCode
 */
export function promptOpencodeAuth(): void {
  const isInstalled = isOpencodeInstalled();
  
  if (!isInstalled) {
    console.error(`
OpenCode CLI is not installed.

To install OpenCode, visit:
  https://opencode.ai/docs/cli/

Or install via npm:
  npm install -g opencode
`);
    return;
  }
  
  console.error(`
OpenCode requires authentication.

To authenticate, run:
  opencode auth login

This will configure API keys for your preferred providers (Anthropic, OpenAI, Google, etc).

For more information: https://opencode.ai/docs/cli/
`);
}

/**
 * Display message when OpenCode is not installed
 */
export function promptOpencodeInstall(): void {
  console.error(`
OpenCode CLI is not installed.

To install OpenCode, visit:
  https://opencode.ai/docs/cli/

Or install via npm:
  npm install -g opencode
`);
}
