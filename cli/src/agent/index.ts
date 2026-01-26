/**
 * Agent Module - Universal agent backend abstraction
 *
 * This module provides the core abstraction layer for different AI agents
 * (Claude, Codex, Gemini, OpenCode, etc.) that can be controlled through
 * the Happy CLI and mobile app.
 */

import { registerDefaultAgents } from './registry';

// Core types, interfaces, and registry - re-export from core/
export type {
  AgentMessage,
  AgentMessageHandler,
  AgentBackend,
  AgentBackendConfig,
  AcpAgentConfig,
  McpServerConfig,
  AgentTransport,
  AgentId,
  SessionId,
  ToolCallId,
  StartSessionResult,
  AgentFactory,
  AgentFactoryOptions,
} from './core';

export { AgentRegistry, agentRegistry } from './core';

// ACP backend (low-level)
export * from './acp';

// Agent factories (high-level, recommended)
export * from './factories';
export { agentRegistrarById, registerDefaultAgents, type AgentRegistrar } from './registry';

/**
 * Initialize all agent backends and register them with the global registry.
 *
 * Call this function during application startup to make all agents available.
 */
export function initializeAgents(): void {
  registerDefaultAgents();
}
