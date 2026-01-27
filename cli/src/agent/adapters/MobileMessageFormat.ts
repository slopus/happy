/**
 * MobileMessageFormat - Types for messages sent to the mobile app
 *
 * This module defines the message format expected by the Happy mobile app.
 * Messages from any agent (Gemini, Codex, Claude, etc.) are transformed
 * to this format before being sent through the Happy server.
 *
 * @module MobileMessageFormat
 */

import type { AgentId } from '@happy/agents';

/**
 * Supported agent types for the mobile app
 */
export type MobileAgentType = AgentId;

/**
 * Message roles for the mobile app
 */
export type MobileMessageRole = 'user' | 'agent';

/**
 * Message metadata sent with each message
 */
export interface MobileMessageMeta {
  /** Source of the message (usually 'cli') */
  sentFrom: string;
  /** Permission mode context */
  permissionMode?: string;
  /** Model name if applicable */
  model?: string | null;
}

/**
 * User message content (from mobile app to CLI)
 */
export interface MobileUserContent {
  type: 'text';
  text: string;
}

/**
 * User message format
 */
export interface MobileUserMessage {
  role: 'user';
  content: MobileUserContent;
  localKey?: string;
  meta?: MobileMessageMeta;
}

/**
 * Agent content types for different agents
 */
export interface MobileAgentContent<T = unknown> {
  /** Agent type identifier */
  type: MobileAgentType;
  /** The actual message payload */
  data: T;
}

/**
 * Agent message format (from CLI to mobile app)
 */
export interface MobileAgentMessage<T = unknown> {
  role: 'agent';
  content: MobileAgentContent<T>;
  meta?: MobileMessageMeta;
}

/**
 * Event content for session events
 */
export interface MobileEventContent {
  id: string;
  type: 'event';
  data: MobileSessionEvent;
}

/**
 * Session event types
 */
export type MobileSessionEvent =
  | { type: 'switch'; mode: 'local' | 'remote' }
  | { type: 'message'; message: string }
  | { type: 'permission-mode-changed'; mode: string }
  | { type: 'ready' };

/**
 * Event message format
 */
export interface MobileEventMessage {
  role: 'agent';
  content: MobileEventContent;
}

/**
 * Union of all mobile message types
 */
export type MobileMessage =
  | MobileUserMessage
  | MobileAgentMessage
  | MobileEventMessage;

/**
 * Normalized payload format for mobile app
 *
 * This is the standardized format that all agent messages
 * are transformed into before sending to the mobile app.
 */
export interface NormalizedMobilePayload {
  /** Message type (matches AgentMessage.type) */
  type: string;

  /** Text content for model output */
  text?: string;

  /** Status value for status messages */
  status?: string;
  statusDetail?: string;

  /** Tool information for tool calls/results */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  toolResult?: unknown;

  /** Permission information */
  permissionId?: string;
  permissionReason?: string;
  permissionPayload?: unknown;
  permissionApproved?: boolean;

  /** File edit information */
  editDescription?: string;
  editDiff?: string;
  editPath?: string;

  /** Terminal output */
  terminalData?: string;

  /** Generic event data */
  eventName?: string;
  eventPayload?: unknown;

  /** Token count data */
  tokenCount?: Record<string, unknown>;

  /** Raw original message for debugging */
  _raw?: unknown;
}
