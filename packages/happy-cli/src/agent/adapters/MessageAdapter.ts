/**
 * MessageAdapter - Transforms agent messages to mobile format
 *
 * This module provides the transformation layer between internal
 * AgentMessage format and the format expected by the mobile app.
 *
 * The adapter:
 * - Normalizes messages from different agents into a consistent format
 * - Handles agent-specific message variations
 * - Provides type-safe transformations
 *
 * @module MessageAdapter
 */

import type {
  AgentMessage,
  ModelOutputMessage,
  StatusMessage,
  ToolCallMessage,
  ToolResultMessage,
  PermissionRequestMessage,
  PermissionResponseMessage,
  FsEditMessage,
  TerminalOutputMessage,
  EventMessage,
} from '../core/AgentMessage';

import type {
  MobileAgentType,
  MobileAgentMessage,
  MobileMessageMeta,
  NormalizedMobilePayload,
} from './MobileMessageFormat';

/**
 * Configuration for MessageAdapter
 */
export interface MessageAdapterConfig {
  /** Agent type for message wrapping */
  agentType: MobileAgentType;
  /** Include raw message in payload for debugging */
  includeRaw?: boolean;
}

/**
 * MessageAdapter - Transforms AgentMessage to mobile format
 *
 * Usage:
 * ```typescript
 * const adapter = new MessageAdapter({ agentType: 'gemini' });
 * const mobileMsg = adapter.toMobile(agentMessage);
 * apiSession.sendAgentMessage(adapter.agentType, mobileMsg.content.data);
 * ```
 */
export class MessageAdapter {
  private readonly config: MessageAdapterConfig;

  constructor(config: MessageAdapterConfig) {
    this.config = config;
  }

  get agentType(): MobileAgentType {
    return this.config.agentType;
  }

  /**
   * Transform an AgentMessage to mobile format
   */
  toMobile(msg: AgentMessage): MobileAgentMessage<NormalizedMobilePayload> {
    const payload = this.normalize(msg);

    return {
      role: 'agent',
      content: {
        type: this.config.agentType,
        data: payload,
      },
      meta: this.createMeta(),
    };
  }

  /**
   * Normalize an AgentMessage to a consistent payload format
   */
  normalize(msg: AgentMessage): NormalizedMobilePayload {
    const base: NormalizedMobilePayload = {
      type: msg.type,
      ...(this.config.includeRaw ? { _raw: msg } : {}),
    };

    switch (msg.type) {
      case 'model-output':
        return this.normalizeModelOutput(msg, base);

      case 'status':
        return this.normalizeStatus(msg, base);

      case 'tool-call':
        return this.normalizeToolCall(msg, base);

      case 'tool-result':
        return this.normalizeToolResult(msg, base);

      case 'permission-request':
        return this.normalizePermissionRequest(msg, base);

      case 'permission-response':
        return this.normalizePermissionResponse(msg, base);

      case 'fs-edit':
        return this.normalizeFsEdit(msg, base);

      case 'terminal-output':
        return this.normalizeTerminalOutput(msg, base);

      case 'event':
        return this.normalizeEvent(msg, base);

      case 'token-count':
        return { ...base, tokenCount: msg };

      case 'exec-approval-request':
        return {
          ...base,
          toolCallId: msg.call_id,
          toolName: 'exec',
          toolArgs: msg as Record<string, unknown>,
        };

      case 'patch-apply-begin':
        return {
          ...base,
          toolCallId: msg.call_id,
          toolName: 'patch',
          toolArgs: { changes: msg.changes, autoApproved: msg.auto_approved },
        };

      case 'patch-apply-end':
        return {
          ...base,
          toolCallId: msg.call_id,
          toolResult: {
            success: msg.success,
            stdout: msg.stdout,
            stderr: msg.stderr,
          },
        };

      default:
        // Forward unknown types as-is
        return { ...base, eventPayload: msg };
    }
  }

  private normalizeModelOutput(
    msg: ModelOutputMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      text: msg.textDelta ?? msg.fullText,
    };
  }

  private normalizeStatus(
    msg: StatusMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      status: msg.status,
      statusDetail: msg.detail,
    };
  }

  private normalizeToolCall(
    msg: ToolCallMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      toolName: msg.toolName,
      toolArgs: msg.args,
      toolCallId: msg.callId,
    };
  }

  private normalizeToolResult(
    msg: ToolResultMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      toolName: msg.toolName,
      toolResult: msg.result,
      toolCallId: msg.callId,
    };
  }

  private normalizePermissionRequest(
    msg: PermissionRequestMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      permissionId: msg.id,
      permissionReason: msg.reason,
      permissionPayload: msg.payload,
    };
  }

  private normalizePermissionResponse(
    msg: PermissionResponseMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      permissionId: msg.id,
      permissionApproved: msg.approved,
    };
  }

  private normalizeFsEdit(
    msg: FsEditMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      editDescription: msg.description,
      editDiff: msg.diff,
      editPath: msg.path,
    };
  }

  private normalizeTerminalOutput(
    msg: TerminalOutputMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      terminalData: msg.data,
    };
  }

  private normalizeEvent(
    msg: EventMessage,
    base: NormalizedMobilePayload
  ): NormalizedMobilePayload {
    return {
      ...base,
      eventName: msg.name,
      eventPayload: msg.payload,
    };
  }

  private createMeta(): MobileMessageMeta {
    return {
      sentFrom: 'cli',
    };
  }
}

/**
 * Create a MessageAdapter for a specific agent type
 */
export function createMessageAdapter(
  agentType: MobileAgentType,
  options?: Partial<Omit<MessageAdapterConfig, 'agentType'>>
): MessageAdapter {
  return new MessageAdapter({
    agentType,
    ...options,
  });
}

/**
 * Pre-configured adapters for common agents
 */
export const adapters = {
  gemini: new MessageAdapter({ agentType: 'gemini' }),
  codex: new MessageAdapter({ agentType: 'codex' }),
  claude: new MessageAdapter({ agentType: 'claude' }),
  opencode: new MessageAdapter({ agentType: 'opencode' }),
} as const;
