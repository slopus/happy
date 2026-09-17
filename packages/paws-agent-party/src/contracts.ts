import type { AgentRequest, Machine, Message } from '@wangjs-jacky/paws-agent';

export type RoleId = 'moderator' | 'trend30' | 'structure10' | 'timing1';
export type Engine = 'codex' | 'claude' | 'gemini' | 'opencode';
export type RunMode = 'single' | 'consultation';
export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type FollowUpStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export type ImageRef = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

export type StartInput = {
  requestId: string;
  stock: string;
  text: string;
  images: ImageRef[];
  machineId: string;
  directory: string;
  agents: Record<RoleId, Engine>;
  mode: RunMode;
};

export type RoleSnapshot = {
  role: RoleId;
  status: string;
  sessionId?: string;
  error?: string;
};

export type FollowUpRoleSnapshot = {
  status: FollowUpStatus;
  error?: string;
};

/**
 * Durable outcome of one accepted follow-up request. `status` summarizes all
 * addressed roles; per-role terminal errors remain in `roles`. Queued/running
 * records become interrupted on service restart and are never replayed.
 */
export type FollowUpSnapshot = {
  requestId: string;
  to: RoleId[];
  status: FollowUpStatus;
  roles: Partial<Record<RoleId, FollowUpRoleSnapshot>>;
  createdAt: number;
  error?: string;
};

export type RunSnapshot = {
  id: string;
  partyId: string;
  stock: string;
  mode: RunMode;
  status: RunStatus;
  phase: string;
  createdAt: number;
  roles: Record<RoleId, RoleSnapshot>;
  followUps: FollowUpSnapshot[];
  turns: TurnProvenance[];
  error?: string;
};

/** Exact durable associations; absent fields mean that stage was never observed. */
export type TurnProvenance = {
  runId: string;
  partyId: string;
  participant: RoleId;
  taskMessageId: string;
  publicMessageId?: string;
  sessionId?: string;
  localId?: string;
  rootTurnId?: string;
  /** Durable SDK turn-end record, not the text fragment. */
  sourceMessageId?: string;
};

export type ConnectionStatus = {
  state: 'disconnected' | 'linking' | 'connecting' | 'ready' | 'error';
  serverUrl?: string;
  qrUrl?: string;
  error?: string;
};

export type AgentMessagesResponse = {
  sessionId?: string;
  messages: Message[];
  hasMore: boolean;
  requests: AgentRequest[];
  status: string;
};

export type MachinesResponse = { machines: Machine[] };

export type PartyEnvelope = {
  v: 1;
  text: string;
  images: ImageRef[];
};

export type FollowUpInput = {
  requestId: string;
  text: string;
  to: RoleId[];
  images: ImageRef[];
};

export const ROLE_IDS: readonly RoleId[] = ['moderator', 'trend30', 'structure10', 'timing1'];
