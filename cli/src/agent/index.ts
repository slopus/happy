/**
 * Agent Module - Universal agent backend abstraction
 * 
 * This module provides the core abstraction layer for different AI agents
 * (Claude, Codex, Gemini, OpenCode, etc.) that can be controlled through
 * the Happy CLI and mobile app.
 */

// Core types and interfaces
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
} from './AgentBackend';

// Registry
export { AgentRegistry, agentRegistry, type AgentFactory, type AgentFactoryOptions } from './AgentRegistry';

// ACP implementations
export * from './acp';

/**
 * Initialize all agent backends and register them with the global registry.
 * 
 * Call this function during application startup to make all agents available.
 */
export function initializeAgents(): void {
  // Import and register agents
  const { registerGeminiAgent } = require('./acp/gemini');
  registerGeminiAgent();
}

