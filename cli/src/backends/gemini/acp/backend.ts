/**
 * Gemini ACP Backend - Gemini CLI agent via ACP
 * 
 * This module provides a factory function for creating a Gemini backend
 * that communicates using the Agent Client Protocol (ACP).
 * 
 * Gemini CLI is a reference ACP implementation from Google that supports
 * the --experimental-acp flag for ACP mode.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '@/agent/core';
import { geminiTransport } from '@/backends/gemini/acp/transport';
import { logger } from '@/ui/logger';
import { 
  GEMINI_API_KEY_ENV, 
  GOOGLE_API_KEY_ENV, 
  GEMINI_MODEL_ENV, 
  DEFAULT_GEMINI_MODEL 
} from '@/backends/gemini/constants';
import { 
  readGeminiLocalConfig, 
  determineGeminiModel,
  getGeminiModelSource
} from '@/backends/gemini/utils/config';

/**
 * Options for creating a Gemini ACP backend
 */
export interface GeminiBackendOptions extends AgentFactoryOptions {
  /** API key for Gemini (defaults to GEMINI_API_KEY or GOOGLE_API_KEY env var) */
  apiKey?: string;
  
  /** OAuth token from Happy cloud (via 'happy connect gemini') - highest priority */
  cloudToken?: string;
  
  /** Current user email (from OAuth id_token) - used to match per-account project ID */
  currentUserEmail?: string;
  
  /** Model to use. If undefined, will use local config, env var, or default.
   *  If explicitly set to null, will use default (skip local config).
   *  (defaults to GEMINI_MODEL env var or 'gemini-2.5-pro') */
  model?: string | null;
  
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  
  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating a Gemini backend
 */
export interface GeminiBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used (single source of truth) */
  model: string;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'env-var' | 'local-config' | 'default';
}

/**
 * Create a Gemini backend using ACP (official SDK).
 *
 * The Gemini CLI must be installed and available in PATH.
 * Uses the --experimental-acp flag to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns GeminiBackendResult with backend and resolved model (single source of truth)
 */
export function createGeminiBackend(options: GeminiBackendOptions): GeminiBackendResult {

  // Resolve API key from multiple sources (in priority order):
  // 1. Happy cloud OAuth token (via 'happy connect gemini') - highest priority
  // 2. Local Gemini CLI config files (~/.gemini/)
  // 3. GEMINI_API_KEY environment variable
  // 4. GOOGLE_API_KEY environment variable - lowest priority
  
  // Try reading from local Gemini CLI config (token and model)
  const localConfig = readGeminiLocalConfig();
  
  let apiKey = options.cloudToken       // 1. Happy cloud token (passed from runGemini)
    || localConfig.token                // 2. Local config (~/.gemini/)
    || process.env[GEMINI_API_KEY_ENV]  // 3. GEMINI_API_KEY env var
    || process.env[GOOGLE_API_KEY_ENV]  // 4. GOOGLE_API_KEY env var
    || options.apiKey;                  // 5. Explicit apiKey option (fallback)

  if (!apiKey) {
    logger.warn(`[Gemini] No API key found. Run 'happy connect gemini' to authenticate via Google OAuth, or set ${GEMINI_API_KEY_ENV} environment variable.`);
  }

  // Command to run gemini
  const geminiCommand = 'gemini';
  
  // Get model from options, local config, system environment, or use default
  // Priority: options.model (if provided) > local config > env var > default
  // If options.model is undefined, check local config, then env, then use default
  // If options.model is explicitly null, skip local config and use env/default
  const model = determineGeminiModel(options.model, localConfig);

  // Build args - use only --experimental-acp flag
  // Model is passed via GEMINI_MODEL env var (gemini CLI reads it automatically)
  // We don't use --model flag to avoid potential stdout conflicts with ACP protocol
  const geminiArgs = ['--experimental-acp'];

  // Get Google Cloud Project from local config (for Workspace accounts)
  // Only use if: no email stored (global), or email matches current user
  let googleCloudProject: string | null = null;
  if (localConfig.googleCloudProject) {
    const storedEmail = localConfig.googleCloudProjectEmail;
    const currentEmail = options.currentUserEmail;
    
    // Use project if: no email stored (applies to all), or emails match
    if (!storedEmail || storedEmail === currentEmail) {
      googleCloudProject = localConfig.googleCloudProject;
      logger.debug(`[Gemini] Using Google Cloud Project: ${googleCloudProject}${storedEmail ? ` (for ${storedEmail})` : ' (global)'}`);
    } else {
      logger.debug(`[Gemini] Skipping stored Google Cloud Project (stored for ${storedEmail}, current user is ${currentEmail || 'unknown'})`);
    }
  }

  const backendOptions: AcpBackendOptions = {
    agentName: 'gemini',
    cwd: options.cwd,
    command: geminiCommand,
    args: geminiArgs,
    env: {
      ...options.env,
      ...(apiKey ? { [GEMINI_API_KEY_ENV]: apiKey, [GOOGLE_API_KEY_ENV]: apiKey } : {}),
      // Pass model via env var - gemini CLI reads GEMINI_MODEL automatically
      [GEMINI_MODEL_ENV]: model,
      // Pass Google Cloud Project for Workspace accounts
      ...(googleCloudProject ? { 
        GOOGLE_CLOUD_PROJECT: googleCloudProject,
        GOOGLE_CLOUD_PROJECT_ID: googleCloudProject,
      } : {}),
      // Suppress debug output from gemini CLI to avoid stdout pollution
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: geminiTransport,
    // Check if prompt instructs the agent to change title (for auto-approval of change_title tool)
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return lower.includes('change_title') ||
             lower.includes('change title') ||
             lower.includes('set title') ||
             lower.includes('mcp__happy__change_title');
    },
  };

  // Determine model source for logging
  const modelSource = getGeminiModelSource(options.model, localConfig);

  logger.debug('[Gemini] Creating ACP SDK backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    hasApiKey: !!apiKey,
    model: model,
    modelSource: modelSource,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: new AcpBackend(backendOptions),
    model,
    modelSource,
  };
}
