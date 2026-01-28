/**
 * OpenCode ACP Backend - OpenCode CLI agent via ACP
 * 
 * This module provides a factory function for creating an OpenCode backend
 * that communicates using the Agent Client Protocol (ACP).
 * 
 * OpenCode is a terminal-based coding agent that supports multiple AI providers
 * (Anthropic, OpenAI, Google, etc.) and uses ACP for programmatic access.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { opencodeTransport } from '../transport';
import { logger } from '@/ui/logger';
import { 
  OPENCODE_COMMAND, 
  OPENCODE_ACP_ARGS, 
  OPENCODE_MODEL_ENV 
} from '@/opencode/constants';

/**
 * Options for creating an OpenCode ACP backend
 */
export interface OpencodeBackendOptions extends AgentFactoryOptions {
  /** 
   * Model to use (format: provider/model-id, e.g., "anthropic/claude-sonnet-4-20250514").
   * If not provided, uses OpenCode's own config or default.
   */
  model?: string;
  
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  
  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating an OpenCode backend
 */
export interface OpencodeBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'env-var' | 'opencode-default';
}

/**
 * Create an OpenCode backend using ACP.
 *
 * The OpenCode CLI must be installed and available in PATH.
 * Uses the `opencode acp` command to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns OpencodeBackendResult with backend and resolved model
 */
export function createOpencodeBackend(options: OpencodeBackendOptions): OpencodeBackendResult {
  // Build command args
  const args = [...OPENCODE_ACP_ARGS];
  
  // Determine model from: explicit option > env var > let opencode decide
  let model: string;
  let modelSource: 'explicit' | 'env-var' | 'opencode-default';
  
  if (options.model) {
    // Explicit model provided via --model flag
    args.push('--model', options.model);
    model = options.model;
    modelSource = 'explicit';
  } else if (process.env[OPENCODE_MODEL_ENV]) {
    // Model from environment variable
    model = process.env[OPENCODE_MODEL_ENV];
    modelSource = 'env-var';
    // OpenCode will read from its own env var or config
  } else {
    // Let OpenCode use its configured default
    model = 'opencode-default';
    modelSource = 'opencode-default';
  }

  const backendOptions: AcpBackendOptions = {
    agentName: 'opencode',
    cwd: options.cwd,
    command: OPENCODE_COMMAND,
    args: args,
    env: {
      ...options.env,
      // Suppress debug output to avoid stdout pollution
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: opencodeTransport,
    // Check if prompt instructs the agent to change title (for auto-approval of change_title tool)
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return lower.includes('change_title') ||
             lower.includes('change title') ||
             lower.includes('set title') ||
             lower.includes('mcp__happy__change_title');
    },
  };

  logger.debug('[OpenCode] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
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
export function registerOpencodeAgent(): void {
  agentRegistry.register('opencode', (opts) => createOpencodeBackend(opts).backend);
  logger.debug('[OpenCode] Registered with agent registry');
}
