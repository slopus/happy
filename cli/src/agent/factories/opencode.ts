/**
 * OpenCode ACP Backend - OpenCode CLI agent via ACP
 * 
 * This module provides a factory function for creating an OpenCode backend
 * that communicates using the Agent Client Protocol (ACP).
 * 
 * OpenCode CLI supports the `acp` subcommand for ACP mode.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { openCodeTransport } from '../transport';
import { logger } from '@/ui/logger';
import { 
  OPENCODE_API_KEY_ENV, 
  ANTHROPIC_API_KEY_ENV,
  OPENCODE_MODEL_ENV, 
  DEFAULT_OPENCODE_MODEL 
} from '@/opencode/constants';

/**
 * Options for creating an OpenCode ACP backend
 */
export interface OpenCodeBackendOptions extends AgentFactoryOptions {
  /** API key for OpenCode (defaults to OPENCODE_API_KEY or ANTHROPIC_API_KEY env var) */
  apiKey?: string;
  
  /** Model to use. If undefined, will use env var or default.
   *  (defaults to OPENCODE_MODEL env var or 'anthropic/claude-sonnet-4-20250514') */
  model?: string | null;
  
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  
  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating an OpenCode backend
 */
export interface OpenCodeBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used (single source of truth) */
  model: string;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'env-var' | 'default';
}

/**
 * Determine the model to use based on options and environment
 */
function determineOpenCodeModel(optionsModel: string | null | undefined): string {
  // If explicitly provided, use it
  if (optionsModel) {
    return optionsModel;
  }
  
  // If explicitly null, skip to env/default
  if (optionsModel === null) {
    return process.env[OPENCODE_MODEL_ENV] || DEFAULT_OPENCODE_MODEL;
  }
  
  // Check environment variable
  if (process.env[OPENCODE_MODEL_ENV]) {
    return process.env[OPENCODE_MODEL_ENV];
  }
  
  return DEFAULT_OPENCODE_MODEL;
}

/**
 * Get the source of model selection for logging
 */
function getOpenCodeModelSource(optionsModel: string | null | undefined): 'explicit' | 'env-var' | 'default' {
  if (optionsModel) {
    return 'explicit';
  }
  if (process.env[OPENCODE_MODEL_ENV]) {
    return 'env-var';
  }
  return 'default';
}

/**
 * Create an OpenCode backend using ACP.
 *
 * The OpenCode CLI must be installed and available in PATH.
 * Uses the `acp` subcommand to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns OpenCodeBackendResult with backend and resolved model
 */
export function createOpenCodeBackend(options: OpenCodeBackendOptions): OpenCodeBackendResult {
  // Resolve API key from multiple sources (in priority order):
  // 1. OPENCODE_API_KEY environment variable
  // 2. ANTHROPIC_API_KEY environment variable
  // 3. Explicit apiKey option
  
  const apiKey = process.env[OPENCODE_API_KEY_ENV]
    || process.env[ANTHROPIC_API_KEY_ENV]
    || options.apiKey;

  if (!apiKey) {
    logger.warn(`[OpenCode] No API key found. Set ${OPENCODE_API_KEY_ENV} or ${ANTHROPIC_API_KEY_ENV} environment variable.`);
  }

  // Command to run opencode
  const openCodeCommand = 'opencode';
  
  // Get model
  const model = determineOpenCodeModel(options.model);

  // Build args - use acp subcommand
  const openCodeArgs = ['acp'];
  
  // Add working directory if specified
  if (options.cwd) {
    openCodeArgs.push('--cwd', options.cwd);
  }

  const backendOptions: AcpBackendOptions = {
    agentName: 'opencode',
    cwd: options.cwd,
    command: openCodeCommand,
    args: openCodeArgs,
    env: {
      ...options.env,
      // Pass API keys
      ...(apiKey ? { 
        [OPENCODE_API_KEY_ENV]: apiKey, 
        [ANTHROPIC_API_KEY_ENV]: apiKey 
      } : {}),
      // Pass model via env var
      [OPENCODE_MODEL_ENV]: model,
      // Suppress debug output
      NODE_ENV: 'production',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: openCodeTransport,
    // Check if prompt instructs the agent to change title
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return lower.includes('change_title') ||
             lower.includes('change title') ||
             lower.includes('set title') ||
             lower.includes('mcp__happy__change_title');
    },
  };

  // Determine model source for logging
  const modelSource = getOpenCodeModelSource(options.model);

  logger.debug('[OpenCode] Creating ACP backend with options:', {
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

/**
 * Register OpenCode backend with the global agent registry.
 * 
 * This function should be called during application initialization
 * to make the OpenCode agent available for use.
 */
export function registerOpenCodeAgent(): void {
  agentRegistry.register('opencode', (opts) => createOpenCodeBackend(opts).backend);
  logger.debug('[OpenCode] Registered with agent registry');
}
