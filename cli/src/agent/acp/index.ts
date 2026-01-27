/**
 * ACP Module - Agent Client Protocol implementations
 *
 * This module exports all ACP-related functionality including
 * the base AcpBackend and factory helpers.
 *
 * Uses the official @agentclientprotocol/sdk from Zed Industries.
 *
 * For agent-specific backends, use the provider ACP backends (e.g. `@/backends/gemini/acp/backend`).
 */

// Core ACP backend
export { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from './AcpBackend';

// Session update handlers (for testing and extension)
export {
  type SessionUpdate,
  type HandlerContext,
  type HandlerResult,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  parseArgsFromContent,
  extractErrorDetail,
  formatDuration,
  formatDurationMinutes,
  handleAgentMessageChunk,
  handleAgentThoughtChunk,
  handleToolCallUpdate,
  handleToolCall,
  handleLegacyMessageChunk,
  handlePlanUpdate,
  handleThinkingUpdate,
} from './sessionUpdateHandlers';
// Factory helper for generic ACP backends
export { createAcpBackend, type CreateAcpBackendOptions } from './createAcpBackend';

// Catalog-driven ACP backend creation
export * from './createCatalogAcpBackend';

// Legacy aliases for backwards compatibility
export { AcpBackend as AcpSdkBackend } from './AcpBackend';
export type { AcpBackendOptions as AcpSdkBackendOptions } from './AcpBackend';
