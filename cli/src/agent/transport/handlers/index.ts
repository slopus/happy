/**
 * Transport Handler Implementations
 *
 * Agent-specific transport handlers for different CLI agents.
 *
 * @module handlers
 */

export { GeminiTransport, geminiTransport } from './GeminiTransport';
export { OpencodeTransport, opencodeTransport } from './OpencodeTransport';

// Future handlers:
// export { CodexTransport, codexTransport } from './CodexTransport';
// export { ClaudeTransport, claudeTransport } from './ClaudeTransport';
