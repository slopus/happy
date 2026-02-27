import { z } from 'zod'
import { UsageSchema } from '@/claude/types'
import {
  ApiUpdateMachineStateSchema as WireApiUpdateMachineStateSchema,
  ApiUpdateNewMessageSchema as WireApiUpdateNewMessageSchema,
  ApiUpdateSessionStateSchema as WireApiUpdateSessionStateSchema,
  SessionMessageContentSchema as WireSessionMessageContentSchema,
  SessionMessageSchema as WireSessionMessageSchema,
  UpdateSchema as WireUpdateSchema,
  createEnvelope,
} from 'happy-wire'
import type {
  ApiUpdateMachineState as WireApiUpdateMachineState,
  ApiUpdateNewMessage as WireApiUpdateNewMessage,
  ApiUpdateSessionState as WireApiUpdateSessionState,
  SessionMessage as WireSessionMessage,
  SessionMessageContent as WireSessionMessageContent,
  SessionEnvelope,
  SessionEvent,
  SessionRole,
  Update as WireUpdate,
} from 'happy-wire'

// Re-export shared wire protocol types from happy-wire
export type {
  SessionEnvelope,
  SessionEvent,
  SessionRole,
}
export { createEnvelope }

/**
 * Permission mode type - includes both Claude and Codex modes
 * Must match MessageMetaSchema.permissionMode enum values
 *
 * Claude modes: default, acceptEdits, bypassPermissions, plan
 * Codex modes: read-only, safe-yolo, yolo
 *
 * When calling Claude SDK, Codex modes are mapped at the SDK boundary:
 * - yolo → bypassPermissions
 * - safe-yolo → default
 * - read-only → default
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo'

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

/**
 * Base message content structure for encrypted messages
 */
export const SessionMessageContentSchema = WireSessionMessageContentSchema
export type SessionMessageContent = WireSessionMessageContent

/**
 * Update body for new messages
 */
export const UpdateBodySchema = WireApiUpdateNewMessageSchema
export type UpdateBody = WireApiUpdateNewMessage

export const UpdateSessionBodySchema = WireApiUpdateSessionStateSchema
export type UpdateSessionBody = WireApiUpdateSessionState

/**
 * Update body for machine updates
 */
export const UpdateMachineBodySchema = WireApiUpdateMachineStateSchema
export type UpdateMachineBody = WireApiUpdateMachineState

/**
 * Update event from server
 */
export const UpdateSchema = WireUpdateSchema
export type Update = WireUpdate

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data:
    | { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean }
    | { type: 'message-syncing', id: string, count: number }
    | { type: 'message-synced', id: string, count: number }
    | { type: 'message-errored', id: string, error: string }
    | { type: 'machine-activity', id: string, active: boolean, activeAt: number }
    | { type: 'usage', id: string, key: string, tokens: Record<string, number>, cost: Record<string, number>, timestamp: number }
    | { type: 'machine-status', machineId: string, online: boolean, timestamp: number }
  ) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  message: (data: { sid: string, message: any, localId?: string }) => void
  'message-batch': (data: { sid: string, messages: { message: string, localId?: string | null }[], mode?: 'replace' | 'append' }, callback: (response: { result: 'success' | 'error', inserted?: number }) => void) => void
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
  }) => void
  'session-end': (data: { sid: string, time: number }) => void,
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void,
  'update-state': (data: { sid: string, expectedVersion: number, agentState: string | null }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    agentState: string | null
  } | {
    result: 'success',
    version: number,
    agentState: string | null
  }) => void) => void,
  'ping': (callback: () => void) => void
  'rpc-register': (data: { method: string }) => void
  'rpc-unregister': (data: { method: string }) => void
  'rpc-call': (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
  'usage-report': (data: {
    key: string
    sessionId: string
    tokens: {
      total: number
      [key: string]: number
    }
    cost: {
      total: number
      [key: string]: number
    }
  }, callback?: (response: { success: boolean; error?: string }) => void) => void
}

/**
 * Session information
 */
export type Session = {
  id: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
}

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string()
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

/**
 * Session message from API
 */
export const SessionMessageSchema = WireSessionMessageSchema
export type SessionMessage = WireSessionMessage

/**
 * Message metadata schema
 */
export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(), // Source identifier
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(), // Permission mode for this message
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  reasoningEffort: z.string().nullable().optional(), // Reasoning effort for this message (null = reset)
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional() // Disallowed tools for this message (null = reset)
})

export type MessageMeta = z.infer<typeof MessageMetaSchema>

/**
 * API response types
 */
export const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const ImageContentSchema = z.object({
    type: z.literal('image'),
    url: z.string(),
    width: z.number(),
    height: z.number(),
    mimeType: z.string(),
    thumbhash: z.string().optional(),
});

export type ImageContent = z.infer<typeof ImageContentSchema>;

export const UserMessageSchema = z.object({
    role: z.literal('user'),
    content: z.union([
        z.object({
            type: z.literal('text'),
            text: z.string(),
        }),
        z.object({
            type: z.literal('mixed'),
            text: z.string(),
            images: z.array(ImageContentSchema),
        }),
    ]),
    localKey: z.string().optional(),
    meta: MessageMetaSchema.optional(),
});

export type UserMessage = z.infer<typeof UserMessageSchema>

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.any()
  }),
  meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

export type Metadata = {
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  model?: string,
  reasoningEffort?: string,
  // ACP session configuration metadata
  models?: Array<{
    code: string,
    value: string,
    description?: string | null,
  }>,
  currentModelCode?: string,
  operatingModes?: Array<{
    code: string,
    value: string,
    description?: string | null,
  }>,
  currentOperatingModeCode?: string,
  thoughtLevels?: Array<{
    code: string,
    value: string,
    description?: string | null,
  }>,
  currentThoughtLevelCode?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  summaryPinned?: boolean,
  machineId?: string,
  claudeSessionId?: string, // Claude Code session ID
  tools?: string[],
  slashCommands?: string[],
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  startedBy?: 'daemon' | 'terminal',
  // Lifecycle state management
  lifecycleState?: 'running' | 'archiveRequested' | 'archived' | string,
  lifecycleStateSince?: number,
  archivedBy?: string,
  archiveReason?: string,
  flavor?: string,
  // Worktree metadata
  isWorktree?: boolean,
  worktreeBasePath?: string,
  worktreeBranchName?: string,
  worktreePrUrl?: string,
  reviewOfSessionId?: string,
  workspaceRepos?: Array<{
    repoId?: string;
    path: string;
    basePath: string;
    branchName: string;
    targetBranch?: string;
    prUrl?: string;
    displayName?: string;
  }>;
  workspacePath?: string,
};

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  taskCompleted?: number | null | undefined
  requests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
      allowTools?: string[]
    }
  }
}
