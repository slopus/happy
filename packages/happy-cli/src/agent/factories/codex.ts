/**
 * Codex App-Server Backend Factory
 *
 * Factory function for creating a Codex backend that communicates
 * via the app-server JSON-RPC protocol.
 */

import {
  CodexAppServerBackend,
  type CodexAppServerBackendOptions,
  type CodexPermissionHandler,
  type ApprovalPolicy,
  type SandboxMode,
} from '@/codex/appserver';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { logger } from '@/ui/logger';

/**
 * Options for creating a Codex app-server backend
 */
export interface CodexBackendOptions extends AgentFactoryOptions {
  /** Model to use (e.g. 'codex-mini', 'o4-mini') */
  model?: string | null;
  /** Model reasoning effort (e.g. 'low', 'medium', 'high') */
  reasoningEffort?: string | null;
  /** Approval policy */
  approvalPolicy?: ApprovalPolicy | null;
  /** Sandbox mode */
  sandbox?: SandboxMode | null;
  /** Base instructions (system prompt) for the agent */
  baseInstructions?: string | null;
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  /** Permission handler for tool approvals */
  permissionHandler?: CodexPermissionHandler;
  /** Rollout file path for session resume */
  resumeFile?: string | null;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Result of creating a Codex backend
 */
export interface CodexBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used (null = Codex default) */
  model: string | null;
}

/**
 * Create a Codex backend using the app-server JSON-RPC protocol.
 *
 * The Codex CLI must be installed and available in PATH.
 * Spawns `codex app-server` as a child process.
 *
 * If no model is specified, the Codex CLI will use its own default
 * (consistent with how Claude Code handles model selection).
 */
export function createCodexBackend(options: CodexBackendOptions): CodexBackendResult {
  // Let Codex choose the default model based on auth method (API key vs ChatGPT)
  const model = options.model ?? process.env.CODEX_MODEL ?? null;

  const backendOptions: CodexAppServerBackendOptions = {
    cwd: options.cwd,
    command: 'npx',
    args: ['-y', '@openai/codex@0.115.0', 'app-server'],
    env: {
      ...options.env,
    },
    model,
    reasoningEffort: options.reasoningEffort,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
    baseInstructions: options.baseInstructions,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    resumeFile: options.resumeFile,
    signal: options.signal,
  };

  logger.debug('[Codex] Creating app-server backend with options:', {
    cwd: backendOptions.cwd,
    model: model ?? '(Codex CLI default)',
    reasoningEffort: options.reasoningEffort ?? '(Codex CLI default)',
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
    hasResumeFile: !!options.resumeFile,
  });

  return {
    backend: new CodexAppServerBackend(backendOptions),
    model,
  };
}

/**
 * Register Codex backend with the global agent registry.
 */
export function registerCodexAgent(): void {
  agentRegistry.register('codex', (opts) => createCodexBackend(opts as CodexBackendOptions).backend);
  logger.debug('[Codex] Registered with agent registry');
}
