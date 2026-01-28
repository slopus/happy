/**
 * Agent Module - Universal agent backend abstraction
 *
 * This module provides the core abstraction layer for different AI agents
 * (Claude, Codex, Gemini, OpenCode, etc.) that can be controlled through
 * the Happy CLI and mobile app.
 */

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

/**
 * Initialize all agent backends and register them with the global registry.
 *
 * Call this function during application startup to make all agents available.
 */
export function initializeAgents(): void {
  // Import and register agents from factories
  const { registerGeminiAgent } = require('./factories/gemini');
  registerGeminiAgent();
}

