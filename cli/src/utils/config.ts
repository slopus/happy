/**
 * Configuration management for handy-cli
 * 
 * This module provides hardcoded configuration values for the application.
 * 
 * Key responsibilities:
 * - Provide typed configuration object
 * - Centralize configuration constants
 * 
 * Design decisions:
 * - Hardcoded values instead of environment variables for simplicity
 * - Server URL points to the known handy-api server
 * - Socket path uses a known path for session updates
 */

export interface Config {
  serverUrl: string
  socketPath: string
}

/**
 * Get the application configuration
 */
export function getConfig(): Config {
  return {
    serverUrl: 'https://handy-api.korshakov.org',
    socketPath: '/v1/updates'
  }
}