/**
 * Configuration management for handy-cli
 * 
 * This module handles loading and validating configuration from environment variables.
 * 
 * Key responsibilities:
 * - Load environment variables from .env file
 * - Provide typed configuration object
 * - Validate required configuration values
 */

import { config as dotenvConfig } from 'dotenv'

// Load environment variables
dotenvConfig()

export interface Config {
  serverUrl: string
  socketPath: string
}

/**
 * Get the application configuration
 */
export function getConfig(): Config {
  const serverUrl = process.env.HANDY_SERVER_URL
  const socketPath = process.env.HANDY_SOCKET_PATH
  
  if (!serverUrl) {
    throw new Error('HANDY_SERVER_URL environment variable is required')
  }
  
  if (!socketPath) {
    throw new Error('HANDY_SOCKET_PATH environment variable is required')
  }
  
  return {
    serverUrl,
    socketPath
  }
}