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

// Future factories:
// export { createCodexBackend, registerCodexAgent, type CodexBackendOptions } from './codex';
// export { createClaudeBackend, registerClaudeAgent, type ClaudeBackendOptions } from './claude';
// export { createOpenCodeBackend, registerOpenCodeAgent, type OpenCodeBackendOptions } from './opencode';
