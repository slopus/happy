/**
 * Path utilities for handy-cli
 * 
 * This module provides utilities for working with file paths,
 * particularly for accessing user home directory and config files.
 * 
 * Key responsibilities:
 * - Resolve paths relative to user home directory
 * - Provide consistent paths for config and secret files
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Get the path to the secret key file in user's home directory
 */
export function getSecretKeyPath(): string {
  return join(homedir(), '.handy-claude-code.key')
}

/**
 * Get the user's home directory
 */
export function getHomeDir(): string {
  return homedir()
}