/**
 * Core Agent Types and Interfaces
 *
 * Re-exports all core agent abstractions.
 *
 * @module core
 */

// ============================================================================
// AgentBackend - Core interface and types
// ============================================================================

export type {
  SessionId,
  ToolCallId,
  AgentMessage,
  AgentMessageHandler,
  AgentBackend,
  AgentBackendConfig,
  AcpAgentConfig,
  McpServerConfig,
  AgentTransport,
  AgentId,
  StartSessionResult,
} from './AgentBackend';

// ============================================================================
// AgentRegistry - Factory registry
// ============================================================================

export {
  AgentRegistry,
  agentRegistry,
} from './AgentRegistry';

export type {
  AgentFactory,
  AgentFactoryOptions,
} from './AgentRegistry';

// ============================================================================
// AgentMessage - Detailed message types with type guards
// ============================================================================

export type {
  AgentStatus,
  ModelOutputMessage,
  StatusMessage,
  ToolCallMessage,
  ToolResultMessage,
  PermissionRequestMessage,
  PermissionResponseMessage,
  FsEditMessage,
  TerminalOutputMessage,
  EventMessage,
  TokenCountMessage,
  ExecApprovalRequestMessage,
  PatchApplyBeginMessage,
  PatchApplyEndMessage,
} from './AgentMessage';

export {
  isModelOutputMessage,
  isStatusMessage,
  isToolCallMessage,
  isToolResultMessage,
  isPermissionRequestMessage,
  getMessageText,
} from './AgentMessage';
