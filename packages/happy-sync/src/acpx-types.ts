/**
 * acpx session types — the wire format for Happy.
 *
 * These types match acpx's internal definitions exactly.
 * Raw SessionMessage goes on the wire. No envelope. No wrapper.
 */

export type { FlowRunState, FlowStepRecord } from 'acpx/flows';

// ─── Images ──────────────────────────────────────────────────────────────────

export type SessionMessageImage = {
  source: string;
  size?: { width: number; height: number } | null;
};

// ─── User content ────────────────────────────────────────────────────────────

export type SessionUserContent =
  | { Text: string }
  | { Mention: { uri: string; content: string } }
  | { Image: SessionMessageImage };

// ─── Tool types ──────────────────────────────────────────────────────────────

export type SessionToolUse = {
  id: string;
  name: string;
  raw_input: string;
  input: unknown;
  is_input_complete: boolean;
  thought_signature?: string | null;
};

export type SessionToolResultContent =
  | { Text: string }
  | { Image: SessionMessageImage };

export type SessionToolResult = {
  tool_use_id: string;
  tool_name: string;
  is_error: boolean;
  content: SessionToolResultContent;
  output?: unknown;
};

// ─── Agent content ───────────────────────────────────────────────────────────

export type SessionAgentContent =
  | { Text: string }
  | { Thinking: { text: string; signature?: string | null } }
  | { RedactedThinking: string }
  | { ToolUse: SessionToolUse };

// ─── Messages ────────────────────────────────────────────────────────────────

export type SessionUserMessage = {
  id: string;
  content: SessionUserContent[];
};

export type SessionAgentMessage = {
  content: SessionAgentContent[];
  tool_results: Record<string, SessionToolResult>;
  reasoning_details?: unknown;
};

export type SessionMessage =
  | { User: SessionUserMessage }
  | { Agent: SessionAgentMessage }
  | 'Resume';

// ─── Session state ───────────────────────────────────────────────────────────

import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export type SessionTokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type SessionAcpxState = {
  current_mode_id?: string;
  desired_mode_id?: string;
  current_model_id?: string;
  available_models?: string[];
  available_commands?: string[];
  config_options?: SessionConfigOption[];
  session_options?: {
    model?: string;
    allowed_tools?: string[];
    max_turns?: number;
  };
};

export type SessionEventLog = {
  active_path: string;
  segment_count: number;
  max_segment_bytes: number;
  max_segments: number;
  last_write_at?: string;
  last_write_error?: string | null;
};

export type SessionRecord = {
  schema: 'acpx.session.v1';
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  createdAt: string;
  lastUsedAt: string;
  lastSeq: number;
  lastRequestId?: string;
  eventLog: SessionEventLog;
  closed?: boolean;
  closedAt?: string;
  pid?: number;
  agentStartedAt?: string;
  lastPromptAt?: string;
  lastAgentExitCode?: number | null;
  lastAgentExitSignal?: NodeJS.Signals | null;
  lastAgentExitAt?: string;
  lastAgentDisconnectReason?: string;
  protocolVersion?: number;
  title?: string | null;
  messages: SessionMessage[];
  updated_at: string;
  cumulative_token_usage: SessionTokenUsage;
  request_token_usage: Record<string, SessionTokenUsage>;
  acpx?: SessionAcpxState;
};
