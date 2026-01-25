/**
 * Agent Factories
 *
 * Factory functions for creating agent backends with proper configuration.
 * Each factory includes the appropriate transport handler for the agent.
 *
 * @module factories
 */

// Gemini factory
export {
  createGeminiBackend,
  registerGeminiAgent,
  type GeminiBackendOptions,
  type GeminiBackendResult,
} from './gemini';

// Codex ACP factory (experimental)
export {
  createCodexAcpBackend,
  type CodexAcpBackendOptions,
  type CodexAcpBackendResult,
} from './codexAcp';

// OpenCode ACP factory
export {
  createOpenCodeBackend,
  registerOpenCodeAgent,
  type OpenCodeBackendOptions,
} from './opencode';

// Future factories:
// export { createCodexBackend, registerCodexAgent, type CodexBackendOptions } from './codex';
// export { createClaudeBackend, registerClaudeAgent, type ClaudeBackendOptions } from './claude';
