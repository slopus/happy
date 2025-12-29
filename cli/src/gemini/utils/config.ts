/**
 * Gemini Configuration Utilities
 * 
 * Utilities for reading and writing Gemini CLI configuration files,
 * including API keys, tokens, and model settings.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { logger } from '@/ui/logger';
import { GEMINI_MODEL_ENV, DEFAULT_GEMINI_MODEL } from '../constants';

/**
 * Result of reading Gemini local configuration
 */
export interface GeminiLocalConfig {
  token: string | null;
  model: string | null;
}

/**
 * Try to read Gemini config (auth token and model) from local Gemini CLI config
 * Gemini CLI stores tokens in ~/.gemini/ or uses gcloud Application Default Credentials
 */
export function readGeminiLocalConfig(): GeminiLocalConfig {
  let token: string | null = null;
  let model: string | null = null;
  
  // Try common Gemini CLI config locations
  // Gemini CLI stores OAuth tokens in ~/.gemini/oauth_creds.json after 'gemini auth'
  const possiblePaths = [
    join(homedir(), '.gemini', 'oauth_creds.json'), // Main OAuth credentials file
    join(homedir(), '.gemini', 'config.json'),
    join(homedir(), '.config', 'gemini', 'config.json'),
    join(homedir(), '.gemini', 'auth.json'),
    join(homedir(), '.config', 'gemini', 'auth.json'),
  ];

  for (const configPath of possiblePaths) {
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        
        // Try different possible token field names
        // oauth_creds.json has access_token field
        if (!token) {
          const foundToken = config.access_token || config.token || config.apiKey || config.GEMINI_API_KEY;
          if (foundToken && typeof foundToken === 'string') {
            token = foundToken;
            logger.debug(`[Gemini] Found token in ${configPath}`);
          }
        }
        
        // Try to read model from config
        if (!model) {
          const foundModel = config.model || config.GEMINI_MODEL;
          if (foundModel && typeof foundModel === 'string') {
            model = foundModel;
            logger.debug(`[Gemini] Found model in ${configPath}: ${model}`);
          }
        }
      } catch (error) {
        logger.debug(`[Gemini] Failed to read config from ${configPath}:`, error);
      }
    }
  }

  // Try gcloud Application Default Credentials
  // Gemini CLI might use gcloud auth application-default print-access-token
  if (!token) {
    try {
      const gcloudToken = execSync('gcloud auth application-default print-access-token', { 
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }).trim();
      if (gcloudToken && gcloudToken.length > 0) {
        token = gcloudToken;
        logger.debug('[Gemini] Found token via gcloud Application Default Credentials');
      }
    } catch (error) {
      // gcloud not available or not authenticated - this is fine
      logger.debug('[Gemini] gcloud Application Default Credentials not available');
    }
  }

  return { token, model };
}

/**
 * Determine the model to use based on priority:
 * 1. Explicit model parameter (if provided)
 * 2. Environment variable (GEMINI_MODEL)
 * 3. Local config file
 * 4. Default model
 * 
 * @param explicitModel - Model explicitly provided (undefined = check sources, null = skip config)
 * @param localConfig - Local config result from readGeminiLocalConfig()
 * @returns The model string to use
 */
export function determineGeminiModel(
  explicitModel: string | null | undefined,
  localConfig: GeminiLocalConfig
): string {
  if (explicitModel !== undefined) {
    if (explicitModel === null) {
      // Explicitly null - use env or default, skip local config
      return process.env[GEMINI_MODEL_ENV] || DEFAULT_GEMINI_MODEL;
    } else {
      // Model explicitly provided - use it
      return explicitModel;
    }
  } else {
    // No explicit model - check env var first (user override), then local config, then default
    // This allows users to override config via environment variable
    const envModel = process.env[GEMINI_MODEL_ENV];
    logger.debug(`[Gemini] Model selection: env[GEMINI_MODEL_ENV]=${envModel}, localConfig.model=${localConfig.model}, DEFAULT=${DEFAULT_GEMINI_MODEL}`);
    const model = envModel || localConfig.model || DEFAULT_GEMINI_MODEL;
    logger.debug(`[Gemini] Selected model: ${model}`);
    return model;
  }
}

/**
 * Save model to Gemini config file
 * 
 * @param model - The model name to save
 */
export function saveGeminiModelToConfig(model: string): void {
  try {
    const configDir = join(homedir(), '.gemini');
    const configPath = join(configDir, 'config.json');
    
    // Create directory if it doesn't exist
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    
    // Read existing config or create new one
    let config: any = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch (error) {
        logger.debug(`[Gemini] Failed to read existing config, creating new one`);
        config = {};
      }
    }
    
    // Update model in config
    config.model = model;
    
    // Write config back
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.debug(`[Gemini] Saved model "${model}" to ${configPath}`);
  } catch (error) {
    logger.debug(`[Gemini] Failed to save model to config:`, error);
    // Don't throw - this is not critical
  }
}

/**
 * Get the initial model value for UI display
 * Priority: env var > local config > default
 * 
 * @returns The initial model string
 */
export function getInitialGeminiModel(): string {
  const localConfig = readGeminiLocalConfig();
  return process.env[GEMINI_MODEL_ENV] || localConfig.model || DEFAULT_GEMINI_MODEL;
}

/**
 * Determine the source of the model for logging purposes
 * 
 * @param explicitModel - Model explicitly provided (undefined = check sources, null = skip config)
 * @param localConfig - Local config result from readGeminiLocalConfig()
 * @returns Source identifier: 'explicit' | 'env-var' | 'local-config' | 'default'
 */
export function getGeminiModelSource(
  explicitModel: string | null | undefined,
  localConfig: GeminiLocalConfig
): 'explicit' | 'env-var' | 'local-config' | 'default' {
  if (explicitModel !== undefined && explicitModel !== null) {
    return 'explicit';
  } else if (process.env[GEMINI_MODEL_ENV]) {
    return 'env-var';
  } else if (localConfig.model) {
    return 'local-config';
  } else {
    return 'default';
  }
}

