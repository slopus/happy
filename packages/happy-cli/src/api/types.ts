import type { RpcRequest, RpcResponseCallback } from './rpc/types';
import { z } from 'zod'
import type { ProviderUsageEventV1, Update, UpdateMachineBody } from '@slopus/happy-wire';
import { authenticatedEnvelopesCapabilitySchema } from '@slopus/happy-wire';
import { UsageSchema } from '@/claude/types'
import { DifficultyRoutingCapabilitySchema, DifficultyRoutingIntentSchema } from '@/difficultyRouting'
import type { SandboxConfig } from '@/persistence'
import { AutonomousQualityGateCapabilityAdvertisementSchema } from './autonomousQualityGateProtocol'

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
  // `callback` is optional because socket.io does not guarantee an ack on
  // every delivered packet — see createRpcRequestListener.
  'rpc-request': (data: RpcRequest, callback?: RpcResponseCallback) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data: { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean, reason?: 'session-socket-disconnected' | 'archived' }) => void
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
  'provider-usage-report': (data: ProviderUsageEventV1) => void
  /** Volatile token-level preview frame; `data` is session-key encrypted. */
  'session-stream': (data: { sid: string; time: number; data: string }) => void
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
    claude: z.boolean(),
    codex: z.boolean(),
    gemini: z.boolean(),
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
  /** Scheduled automations RPC(automation-upsert/remove/list) 지원 여부 광고. */
  automationSupport: z.object({
    rpcAvailable: z.boolean(),
    serverBacked: z.boolean().optional(),
    keyVersion: z.number().int().min(1).optional(),
    sessionFollowup: z.literal(true).optional(),
    protocolVersion: z.number().int().min(1).optional(),
    /** false: 스크립트 조건·GitHub 트리거처럼 Job 밖 명령이 필요한 자동화는 실행하지 않는다(Windows 정식 빌드). */
    hostCommands: z.boolean().optional(),
    /** aplus-dev-studio specs/e2ee-machine-control-boundary R12/R15 — seal with this sender, to this key. */
    authenticatedEnvelopes: authenticatedEnvelopesCapabilitySchema.optional(),
  }).optional(),
  /**
   * External messenger channel support (Saycode specs/desktop-messenger-channels).
   *
   * Advertised so Desktop can refuse to relay a channel message to a daemon that predates the
   * handling. An older daemon ignores `meta.channelOrigin` entirely, which means it would read a
   * channel `/clear` as session control and clear the queue, and would apply the AX
   * plan→acceptEdits promotion to an external turn — the two things the field exists to prevent.
   * Its absence is therefore *not* "probably fine": it is the unsafe case, and Desktop fails
   * closed on it.
   *
   * `engines` lists the agents whose loops actually honour the field and correlate a reply to the
   * request. It is deliberately explicit rather than "all of them": an engine that has not been
   * wired yet would otherwise look supported and answer with the wrong turn.
   */
  channelSupport: z.object({
    protocolVersion: z.literal(1),
    engines: z.array(z.enum(['claude', 'codex', 'gemini', 'openclaw', 'opencode', 'grok'])),
    /**
     * One-shot permission approval from a messenger.
     *
     * A **separate axis** from `engines`, which only says the loop honours `meta.channelOrigin`
     * and correlates a reply to the request. Answering a prompt needs more than that: the prompt
     * must be bound to its turn as it is raised, published without its arguments, consumed
     * atomically, and withdrawn on every path it leaves by. A daemon can do the first and none of
     * the rest.
     *
     * Its own `protocolVersion` for the same reason `channelSupport` has one: the approval event
     * shape can move without the channel transport moving. Not derived, not defaulted — absence
     * means the daemon cannot do it, and a caller that offers the button anyway offers one whose
     * answers are always refused. `engines` is a claim about each engine's loop, not the build.
     */
    approvals: z.object({
      protocolVersion: z.literal(1),
      engines: z.array(z.enum(['claude', 'codex', 'gemini', 'openclaw', 'opencode', 'grok'])),
    }).optional(),
  }).optional(),
  /**
   * The daemon channel host (Saycode specs/happy-cli-channel-host, R16).
   *
   * Present only while the host child is running and has said `ready`: custody of its credentials
   * works and its key is loaded. Removed when the child dies or reports itself unavailable, so a
   * Desktop that assigned a connection here sees the loss instead of trusting a stale copy.
   * `hostKey` is the host's own box public key that Desktop seals credential envelopes to.
   */
  channelHost: z.object({
    protocolVersion: z.literal(1),
    custody: z.literal('available'),
    isolation: z.enum(['available', 'unavailable']),
    providers: z.array(z.string()),
    hostKey: z.string(),
    fingerprint: z.string(),
  }).optional(),
  autonomousQualityGateSupport: AutonomousQualityGateCapabilityAdvertisementSchema.optional(),
  additionalDirectories: z.object({
    version: z.literal(1),
    maxDirectories: z.literal(8),
    agents: z.tuple([z.literal('claude'), z.literal('codex')]),
    access: z.literal('read-write'),
  }).optional(),
  difficultyRouting: DifficultyRoutingCapabilitySchema.optional(),
  /**
   * 이 daemon 이 spawn param `aiAuthSelection` 을 이해한다고 광고한다.
   *
   * `spawn-happy-session` 은 파라미터를 구조분해만 하므로 구형 daemon 은 선택을
   * 조용히 버린다. 클라이언트는 이 필드를 보고 나서만 선택을 보낸다. 버전을 두는
   * 이유는 필드 유무만으로는 "어느 선택 종류까지 아는가" 를 말할 수 없기 때문이다.
   */
  aiAuthSelection: z.object({ version: z.literal(1) }).optional(),
  /** Current tracked-child presence via encrypted machine RPC (BYOS only). */
  daemonSessionState: z.object({ version: z.literal(1) }).optional(),
  /**
   * Agent Browser execution machine. protocol 2: spawns accept `browserAttestation` (a session-user
   * attestation). Studio sends one only when this is reported, and treats the machine by `tenancyMode`.
   */
  agentBrowser: z.object({ protocol: z.number().int().positive(), tenancyMode: z.enum(['dedicated', 'shared']) }).optional(),
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
    ]).optional(),
  /** Process-local X25519 public key used only for MCP caller grant envelopes. */
  mcpCallerGrantPublicKey: z.string().optional(),
  activity: z.object({
    activeSessionCount: z.number().int().min(0),
    activeAutomationCount: z.number().int().min(0),
    reportedAt: z.number(),
  }).optional(),
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
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  // Whether `model` is a pin the user chose or a per-turn pick a client router
  // made for a Default session. Only a pin is published as the session's active
  // model; publishing a router pick would freeze the session on it. Absent means
  // 'user' so clients that never auto-route (desktop, web) need no change.
  //
  // .catch() for the same reason as saycodePromptBlocks below: a malformed value
  // must never stop the message from being routed. It falls back to 'auto', not
  // to undefined: a client that sent a marker we cannot read has told us the
  // provenance is something other than a plain user pin, and undefined would
  // turn that unknown into a durable pin that freezes the session's model. An
  // omitted field still parses to undefined — only a present, invalid value
  // lands here.
  modelSource: z.enum(['user', 'auto']).optional().catch('auto'),
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  effort: z.string().nullable().optional(), // Reasoning effort for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  saycodeSystemPromptEnabled: z.boolean().optional(), // Explicit policy for Saycode-owned instructions (missing = enabled for compatibility)
  // Per-block overrides for individually toggleable Saycode-owned blocks. Delegation
  // blocks default on; other missing entries inherit saycodeSystemPromptEnabled. The
  // chat title instruction is deliberately excluded because it is always on.
  // nullable = reset to inherit, matching every other override field above.
  // .catch() because a failed safeParse in apiSession.routeIncomingMessage silently
  // stops routing the message as a user message: a malformed preference must degrade
  // to "no override", never swallow the user's turn.
  saycodePromptBlocks: z.object({
    agentOrchestration: z.boolean().optional(),
    coAuthoredCredit: z.boolean().optional(),
    workerDelegation: z.boolean().optional(),
    axBase: z.boolean().optional(),
  }).nullable().optional().catch(undefined),
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
  // .catch() for the same reason as saycodePromptBlocks above: a strict enum drops
  // the user's whole turn in routeIncomingMessage when a newer app sends a step this
  // CLI predates. An unlearned step degrades to "no explicit step", never to silence.
  axStep: z.enum(['plan', 'design', 'free']).optional().catch(undefined),
  difficultyRoutingIntent: DifficultyRoutingIntentSchema.optional().catch(undefined),
  difficultyRoutingPrompt: z.string().optional(),
  difficultyRoutingAuthorization: z.string().optional(),
  // Opt-in browser diagnostics only. The opaque id binds one daemon-local
  // duration record to its originating browser attempt; it is never a user,
  // session, message, or provider identifier.
  latencyTrace: z.object({
    version: z.literal(1),
    id: z.string().uuid(),
  }).optional().catch(undefined),
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

// Runtime-only durable identity supplied by ApiSessionClient from the trusted
// server message row. It is intentionally absent from UserMessageSchema so an
// encrypted client payload cannot choose or spoof this value.
export type UserMessage = z.infer<typeof UserMessageSchema> & {
  serverMessageId?: string
}

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
  models?: Array<{ code: string; value: string; description?: string | null }>,
  currentModelCode?: string,
  operatingModes?: Array<{ code: string; value: string; description?: string | null }>,
  currentOperatingModeCode?: string,
  thoughtLevels?: Array<{ code: string; value: string; description?: string | null }>,
  currentThoughtLevelCode?: string,
  path: string,
  host: string,
  version?: string,
  runtimeCapabilities?: {
    saycodeSystemPromptPreference?: boolean,
  },
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number,
    /** English kebab-case slug for the task, supplied alongside the title for use as a git branch name. */
    branchSlug?: string,
  },
  promptSuggestion?: {
    text: string,
    provider: string,
    updatedAt: number
  } | null,
  machineId?: string,
  claudeSessionId?: string, // Claude Code session ID
  codexThreadId?: string, // Codex app-server thread ID
  tools?: string[],
  slashCommands?: string[],
  claudeBackgroundTasks?: {
    startedAt: number;
    available: boolean;
    tasks: Array<{ taskId: string; label: string; kind: 'shell' | 'agent' }> | null;
  },
  codexBackgroundTasks?: Array<{ callId: string; command: string; processId?: string; status: 'running' | 'unknown' }>,
  mcpServers?: Array<{ name: string; status: string; error?: string; checkedAt?: number }>,
  skills?: string[],
  plugins?: Array<{ name: string; path: string }>,
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
   * Identity of the account that requested this session's creation, as
   * reported by the client (e.g. desktop app). Additive — absent on
   * sessions created before this field existed and on any spawn that
   * doesn't supply it (specs/session-created-by).
   */
  createdBy?: { accountId: string; displayName?: string }
  /**
   * Auto-routing state. Deliberately `unknown`: the record may be the pre-v2
   * shape (`{ difficulty, hardTurns, updatedAt }`), the versioned v2 shape, or
   * one written by a newer CLI that this build cannot represent. Every reader
   * goes through `normalizeRoutingSessionState`, which validates it and reports
   * an unreadable record as an unknown floor rather than as an absent one — a
   * typed field here would invite exactly the unchecked cast that loses that
   * distinction.
   */
  difficultyRoutingState?: unknown
};

export type AgentGoalStatus = {
  source: 'claude' | 'codex',
  observedAt: number,
  sourceSessionId?: string,
  sourceRevision?: string | number,
} & (
  | {
      status: 'unavailable',
      reason?: 'unsupported' | 'not_loaded' | 'stale' | 'malformed' | 'error' | 'unknown',
    }
  | {
      status: 'inactive',
      reason?: 'none' | 'cleared' | 'completed' | 'unknown',
    }
  | {
      status: 'active',
      sourceSessionId: string,
      text: string,
      capabilities?: {
        clear?: boolean,
        stop?: boolean,
        edit?: boolean,
      },
      progress?: {
        currentStep?: number,
        totalSteps?: number,
        steps?: Array<{
          text: string,
          status: 'pending' | 'in_progress' | 'completed',
        }>,
      },
    }
);

export type AgentState = {
  controlledByUser?: boolean | null | undefined
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
  agentGoalStatus?: AgentGoalStatus
}
