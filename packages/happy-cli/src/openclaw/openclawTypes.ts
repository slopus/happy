/**
 * OpenClaw Gateway Protocol Types
 *
 * These types match the OpenClaw gateway WebSocket protocol (v3).
 * Ported from expo-app/sources/clawdbot/clawdbotTypes.ts for Node.js CLI usage.
 */

export interface OpenClawGatewayConfig {
  url: string;
  token?: string;
  password?: string;
}

export interface OpenClawRequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export interface OpenClawResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface OpenClawEventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  payloadJSON?: string;
  seq?: number;
}

export type OpenClawFrame = OpenClawRequestFrame | OpenClawResponseFrame | OpenClawEventFrame;

export type OpenClawClientId =
  | 'webchat-ui'
  | 'clawdbot-control-ui'
  | 'webchat'
  | 'cli'
  | 'gateway-client'
  | 'clawdbot-macos'
  | 'clawdbot-ios'
  | 'clawdbot-android'
  | 'node-host'
  | 'test'
  | 'fingerprint'
  | 'clawdbot-probe';

export type OpenClawClientMode =
  | 'webchat'
  | 'cli'
  | 'ui'
  | 'backend'
  | 'node'
  | 'probe'
  | 'test';

export interface OpenClawDeviceIdentity {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce?: string;
}

export interface OpenClawConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: OpenClawClientId;
    displayName?: string;
    version: string;
    platform: string;
    mode: OpenClawClientMode;
  };
  role: string;
  scopes: string[];
  device?: OpenClawDeviceIdentity;
  auth?: { token?: string; password?: string };
}

export interface OpenClawHelloOk {
  server?: { host?: string };
  snapshot?: {
    sessionDefaults?: { mainSessionKey?: string };
  };
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
  };
}

export interface OpenClawAgent {
  id: string;
  default?: boolean;
  workspace?: string;
  model?: { primary?: string };
}

export interface OpenClawSession {
  key: string;
  kind: 'direct' | 'group' | 'global' | 'unknown';
  label?: string;
  displayName?: string;
  surface?: string;
  subject?: string;
  updatedAt: number | null;
  sessionId?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
}

export interface OpenClawSessionsListResult {
  ts: number;
  path: string;
  count: number;
  defaults: { model: string | null; contextTokens: number | null };
  sessions: OpenClawSession[];
}

export interface OpenClawChatMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: string; text?: string }> | string;
  timestamp?: number;
  stopReason?: string;
}

export interface OpenClawChatHistoryResult {
  sessionKey: string;
  sessionId?: string;
  messages: OpenClawChatMessage[];
  thinkingLevel?: string;
}

export interface OpenClawChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'started' | 'thinking' | 'delta' | 'tool' | 'final' | 'error';
  message?: OpenClawChatMessage;
  delta?: string;
  errorMessage?: string;
}

export interface OpenClawChatSendResult {
  runId: string;
  status: 'started' | 'ok' | 'error' | 'in_flight';
  summary?: string;
}
