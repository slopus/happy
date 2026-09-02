import { z } from 'zod'
import type { Update, UpdateMachineBody } from '@slopus/happy-wire';
import { UsageSchema } from '@/claude/types'
import type { SandboxConfig } from '@/persistence'

export {
  SessionMessageContentSchema,
  SessionMessageSchema,
  UpdateBodySchema,
  UpdateMachineBodySchema,
  UpdateSchema,
  UpdateSessionBodySchema,
} from '@slopus/happy-wire';
export type {
  SessionMessage,
  SessionMessageContent,
  Update,
  UpdateBody,
  UpdateMachineBody,
  UpdateSessionBody,
} from '@slopus/happy-wire';

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
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data: { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean }) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  message: (data: { sid: string, message: any }) => void
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
  }) => void
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
  happyLibDir: z.string(),
  cliAvailability: z.object({
    ask: z.boolean().optional(),
    claude: z.boolean(),
    codex: z.boolean(),
    gemini: z.boolean(),
    opencode: z.boolean(),
    openclaw: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
  resumeSupport: z.object({
    rpcAvailable: z.boolean(),
    requiresSameMachine: z.boolean(),
    requiresHappyAgentAuth: z.boolean(),
    happyAgentAuthenticated: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

export const CodexUsageTokenTotalsSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number(),
})

export const CodexUsageDaySchema = CodexUsageTokenTotalsSchema.extend({
  date: z.string(),
  tokenCountEvents: z.number(),
  sessions: z.number(),
  totalOnlyTokens: z.number(),
})

export const CodexUsageSnapshotSchema = z.object({
  source: z.literal('codex-session-jsonl'),
  codexHome: z.string(),
  sessionsDir: z.string(),
  timeZone: z.string(),
  scannedAt: z.number(),
  today: CodexUsageDaySchema.nullable(),
  yesterday: CodexUsageDaySchema.nullable(),
  days: z.array(CodexUsageDaySchema),
  latestEvent: z.object({
    timestamp: z.string(),
    localDate: z.string(),
    lastTokenUsage: CodexUsageTokenTotalsSchema,
    sessionTotalTokenUsage: CodexUsageTokenTotalsSchema.optional(),
    rateLimits: z.object({
      planType: z.string().optional(),
      primary: z.object({
        usedPercent: z.number().optional(),
        windowMinutes: z.number().optional(),
        resetsAt: z.number().optional(),
      }).optional(),
      secondary: z.object({
        usedPercent: z.number().optional(),
        windowMinutes: z.number().optional(),
        resetsAt: z.number().optional(),
      }).optional(),
      rateLimitReachedType: z.string().nullable().optional(),
    }).optional(),
    rateLimitsTimestamp: z.string().optional(),
  }).nullable(),
  warnings: z.array(z.string()),
})

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
    ]).optional(),
  codexUsage: CodexUsageSnapshotSchema.optional(),
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
 * Message metadata schema
 */
export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(), // Source identifier
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(), // Permission mode for this message
  permissionModeExplicit: z.boolean().optional(), // True when the user selected a per-session mode
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  effort: z.string().nullable().optional(), // Reasoning / thinking effort for this message (null = reset)
  fast: z.boolean().optional(), // Codex Fast service tier for this message
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
  editedFromMessageId: z.string().optional() // User message superseded by this edited resend
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

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  localKey: z.string().optional(), // Mobile messages include this
  meta: MessageMetaSchema.optional()
})

export type UserMessage = z.infer<typeof UserMessageSchema>

/**
 * File event message — sent by the app as a session envelope before the text message.
 * Contains a ref pointing to the encrypted blob on the server.
 */
export const FileEventMessageSchema = z.object({
  role: z.literal('session'),
  content: z.object({
    type: z.literal('session'),
    data: z.object({
      id: z.string(),
      time: z.number(),
      role: z.literal('user'),
      ev: z.object({
        t: z.literal('file'),
        ref: z.string(),
        name: z.string(),
        size: z.number(),
        mimeType: z.string().optional(),
        // 附件语义类型；缺省视为 'image'（兼容历史 file event）。
        kind: z.enum(['image', 'audio', 'video', 'file']).optional(),
        // 是否 E2E 加密；缺省视为 true。音视频走明文流式直传 OSS 发 false，
        // 终端据此跳过解密、走 streamAttachmentToDisk 流式落盘。
        encrypted: z.boolean().optional(),
        source: z.enum(['user', 'generated', 'browser_step']).optional(),
        browserStep: z.object({
          label: z.string().min(1),
        }).optional(),
        prompt: z.string().optional(),
        batchId: z.string().optional(),
        localPath: z.string().optional(),
        motionPhoto: z.object({
          videoOffset: z.number().int().nonnegative(),
          videoLength: z.number().int().positive(),
          mimeType: z.literal('video/mp4'),
        }).optional(),
        image: z.object({
          width: z.number(),
          height: z.number(),
          // Optional — native iOS picker has no Canvas to compute thumbhash.
          // App-side schema relaxed this in the same commit; keeping CLI in
          // sync so the file event isn't silently rejected by Zod and the
          // attachment never reaches Claude.
          thumbhash: z.string().optional(),
        }).optional(),
      }),
    }),
  }),
})

export type FileEventMessage = z.infer<typeof FileEventMessageSchema>

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
  /**
   * ACP session config option value (normalized for UI metadata consumers).
   */
  // `code` = protocol value ID, `value` = human label
  models?: Array<{ code: string; value: string; description?: string | null; serviceTiers?: Array<{ id: string; name: string; description?: string | null }> }>,
  currentModelCode?: string,
  operatingModes?: Array<{ code: string; value: string; description?: string | null }>,
  currentOperatingModeCode?: string,
  thoughtLevels?: Array<{ code: string; value: string; description?: string | null }>,
  currentThoughtLevelCode?: string,
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  capabilities?: {
    regenerateTitle?: boolean
  },
  machineId?: string,
  claudeSessionId?: string, // Claude Code session ID
  codexThreadId?: string, // Codex app-server thread ID
  /** Last Codex turn mirrored into this Paws session, used for reconnect catch-up. */
  codexSyncCursor?: {
    threadId: string
    turnId: string
  },
  /** Durable marker for an acknowledged, idempotent Codex history replay. */
  codexHistoryReplay?: {
    threadId: string
    startedAt: number
  },
  /** Opaque key used to recognize this Paws session's user turns in a shared Codex Thread. */
  codexPawsOriginToken?: string,
  tools?: string[],
  slashCommands?: string[],
  mcpServers?: Array<{ name: string; status: string }>,
  skills?: string[],
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
  flavor?: string
  sandbox?: SandboxConfig | null
  dangerouslySkipPermissions?: boolean | null
  /** Lineage for sessions created via the fork / duplicate flow. */
  parentSessionId?: string
  forkedFromMessageId?: string
  /**
   * 带外图库信号（Task 2.2）：AI 调 take_screenshot 后，CLI 把当前会话所有截图的
   * 轻量引用写进 metadata，服务器自动把 metadata 更新推给 App，App 据此懒拉取展示（Task 3.1）。
   * 只放轻量引用（id/来源/备注/时间），不放图片字节。
   */
  screenshotRefs?: Array<{ id: string; target: string; note?: string; takenAt: number }>
  /** 截图版本号/计数，便于 App 检测「有新图」这一变化 */
  screenshotVersion?: number
};

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  queuedMessages?: number
  turnStatus?: {
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    updatedAt: number
    turnId?: string
  }
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
