import type {
  BillingCancellationReason,
  ByokTier,
  CacheCapabilities as ConnectionCacheCapabilities,
  ConnectionCatalogItem,
  HistoryToolStep,
  ModelApiProtocol,
  PurchaseCardField,
  SandboxKind,
  VoiceAccountErrorCode,
} from "@rakazo/contracts";

export interface AdapterContext {
  operationId: string;
  traceId: string;
  spaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  /** Opaque fence for releasing a graphical screen without tearing down its replacement. */
  screenLeaseId?: string;
  /** Retain a completed run's screen for reuse by this bot. */
  keepScreenWarm?: boolean;
  /** When releasing a screen after cancel, also stop orphaned browser work on that screen. */
  cancelRunWork?: boolean;
  signal: AbortSignal;
  /** Connected external accounts available to this run, including their owning connector. */
  connectedConnections?: ConnectedConnector[];
  /** @deprecated Prefer connectedConnections so providers with the same app slug cannot collide. */
  connectedProviders?: string[];
}

export interface ConnectedConnector {
  id: string;
  connectorId: string;
  externalId: string;
  displayName: string;
  providerRef?: string;
}

export interface AdapterDescriptor<TCapabilities> {
  id: string;
  contractVersion: string;
  adapterVersion: string;
  capabilities: TCapabilities;
}

/**
 * In-process OAuth material for a single agent run. Not part of any RPC or
 * persisted contract. Extra provider fields such as `accountId` are copied
 * through at runtime.
 */
export interface AgentModelOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

/**
 * Why a stored OAuth credential is being dropped. `terminal-refresh-failure`
 * means the provider permanently rejected the refresh token; `account-changed`
 * means a refreshed token belongs to a different account than the stored one.
 */
export type ModelCredentialRetireReason = "terminal-refresh-failure" | "account-changed";

/**
 * Identity of the stored credential material whose refresh attempt triggered
 * retirement. Implementations compare access, refresh, and expiry to the secret
 * still on the credential row so a concurrently persisted newer credential —
 * same row rewritten by a successful refresh, or a reconnect — is not deleted
 * by the stale failure.
 */
export interface ModelCredentialFailedState {
  access: string;
  refresh: string;
  expires: number;
}

export interface PortableFile {
  path: string;
  content: Uint8Array;
  executable?: boolean;
}

/**
 * A workspace file too large to hold in memory. Read `body` to the end before asking the export
 * for its next file.
 */
export interface StreamedPortableFile {
  path: string;
  body: AsyncIterable<Uint8Array>;
  executable?: boolean;
}

/** Bounds a workspace export may enforce up front, before copying anything. */
export interface WorkspaceExportLimits {
  maxBytes: number;
  maxFiles: number;
}

export interface ComputerRef {
  id: string;
  botId: string;
  kind: SandboxKind;
  providerRef: string;
  /** True when the provider created an empty replacement rather than reconnecting existing state. */
  fresh?: boolean;
  /** True when this call started a stopped computer. Providers that cannot tell leave it unset. */
  started?: boolean;
}

export type WorkspaceDirectoryRequest =
  | { action: "ensure"; paths: string[] }
  | { action: "list" }
  | { action: "remove"; parent: ".browser-profiles" | "bots"; names: string[] };

export interface CommandRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Remove these variables after all environment overlays, including inherited values. */
  unsetEnv?: string[];
  pty?: boolean;
  /** Maximum wall-clock runtime before the command and its descendants are terminated. */
  timeoutMs?: number;
}

export type ProcessEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number };

export interface ScreenRequest {
  view: "stream" | "snapshot";
  /** Request a separately authorized control stream instead of the read-only viewer. */
  interactive?: boolean;
  /** Fences an interactive stream so an older lease cannot revoke its replacement. */
  controlToken?: string;
}

export interface TerminalRequest {
  /** The active screen control token; a terminal exists only while the user holds control. */
  controlToken: string;
  /** Workspace-relative starting directory. */
  cwd?: string;
}

export interface ScreenSession {
  /** Provider credentials for the server proxy only; never return these to clients. */
  headers?: Record<string, string>;
  url: string | null;
  mimeType: string;
  close(): Promise<void>;
}

export type ComputerInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | {
      kind: "pointer";
      x: number;
      y: number;
      button?: "left" | "right";
      type: "move" | "down" | "up" | "click";
    }
  | { kind: "clipboard"; text: string };

export type ComputerAction =
  | ComputerInput
  /** With x and y, the wheel turns there, so it scrolls what is under that point. */
  | {
      kind: "scroll";
      direction: "up" | "down" | "left" | "right";
      amount?: number;
      x?: number;
      y?: number;
    }
  | { kind: "wait"; ms: number }
  | { kind: "open"; path: string }
  | { kind: "launch"; application: string; uri?: string }
  | { kind: "focus"; application: string; uri?: string };

export interface ComputerObservation {
  frameId: string;
  capturedAt: string;
  mimeType: "image/png" | "image/jpeg";
  image: Uint8Array;
  width: number;
  height: number;
  cursor?: { x: number; y: number };
  activeWindow?: { id: string; title?: string };
}

export interface ComputerActionRequest {
  actions: ComputerAction[];
  observe?: boolean;
  settleMs?: number;
}

export interface ComputerActionResult {
  completed: number;
  observation?: ComputerObservation;
}

export interface ComputerFileEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  executable?: boolean;
}

export type AgentToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

/** A provider-neutral tool result an agent runtime can forward without flattening images. */
export interface AgentToolExecutionResult {
  kind: "agent_tool_result";
  content: AgentToolResultContent[];
  details: unknown;
}

/** Hooks for a tool call that can report output before it returns. */
export interface AgentToolExecutionObserver {
  /**
   * A shell command has already produced output and is still running.
   * Resolves with the final redacted result when the process exits.
   */
  onShellStillRunning?: (
    completion: Promise<{ stdout: string; stderr: string; code: number }>,
  ) => void;
}

/** Ephemeral completion data for audit hooks; result contents must be redacted before persistence. */
export interface AgentToolCompletion {
  name: string;
  executionId: string;
  durationMs: number;
  result?: unknown;
  error?: unknown;
  paused?: boolean;
}

export interface ControlLeaseRef {
  leaseId: string;
  holder: "user" | "bot";
  fence: number;
}

export interface SnapshotRef {
  id: string;
  createdAt: string;
}

export interface SandboxCapabilities {
  graphical: boolean;
  pty: boolean;
  snapshots: boolean;
  takeover: boolean;
  persistentHome: boolean;
  /** Distinct graphical screens for concurrent Team bots on one computer. */
  multiScreen?: boolean;
}

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Declared effect. `false` forces approval; `true` never relaxes the name-based gate. */
  readOnly?: boolean;
  /** Set when the tool runs other actions named in its arguments; see ToolBatch. */
  batch?: ToolBatch;
  /** What the person sees for a call, when the name the model uses would read badly. */
  label?: string;
  /** In-process routing metadata. It is never exposed to the model. */
  route?: ConnectorRoute;
  /** The `ui://` resource an MCP server shows this tool's result with (MCP Apps). */
  appResourceUri?: string;
}

/**
 * Where a batch tool's arguments name the actions it runs: `args[items][i][action]`, each with
 * its own arguments at `args[items][i][arguments]`. Approval rules and the read/write check judge
 * those actions, never the batch tool, so allowing one action cannot allow the rest.
 */
export interface ToolBatch {
  items: string;
  action: string;
  arguments: string;
}

export interface ConnectorRoute {
  connectorId: string;
  toolName: string;
  resourceId?: string;
  resourceRevision?: string | number;
  /** Authorized local connection selected by this tool. Never fall back to another account. */
  connectionId?: string;
  /** Source label for lazy catalog name indexes. Never exposed as a model schema field. */
  catalogGroup?: string;
  /** The `ui://` resource that shows this tool's result; see ConnectorApp. */
  appResourceUri?: string;
}

export interface ConnectorCall {
  tool: string;
  args: Record<string, unknown>;
  connectionId?: string;
  executionId: string;
  route?: ConnectorRoute;
  /** Read the tool's app after a successful call. Only a caller that shows it asks. */
  withApp?: boolean;
}

/**
 * An MCP server's app for one successful call (MCP Apps): HTML the client shows sandboxed with
 * the call's input and result. Declared domains are already narrowed to the ones allowed.
 */
export interface ConnectorApp {
  server: string;
  html: string;
  csp: { connectDomains?: string[]; resourceDomains?: string[] };
  prefersBorder?: boolean;
}

export type ConnectorEvent =
  | { type: "log"; message: string }
  | { type: "result"; data: unknown }
  /** Follows the call's `result` when its tool has an app. */
  | { type: "app"; app: ConnectorApp }
  | { type: "error"; message: string; logIds?: string[] };

export interface ConnectorCapabilities {
  discover: boolean;
  oauth: boolean;
  secretsBrokered: boolean;
}

export type ConnectorCatalogItem = ConnectionCatalogItem;

export interface MemoryReadRequest {
  scope: "bot" | "user";
  botId?: string;
  path?: string;
}

export interface MemorySnapshot {
  documents: Array<{
    id: string;
    path: string;
    content: string;
    revision: number;
    updatedAt?: string;
  }>;
}

export interface MemorySearchRequest {
  query: string;
  scope: "bot" | "user" | "all";
  botId?: string;
}

export interface MemorySearchResult {
  path: string;
  snippet: string;
  score: number;
}

/** A full-document save lost the race to another writer. The caller should read again. */
export const MEMORY_REVISION_CONFLICT_ERROR =
  "Shared memory changed since it was read. Read the latest version and save again.";

export interface MemoryCommitRequest {
  scope: "bot" | "user";
  botId?: string;
  path: string;
  content: string;
  /** When set, commit fails if the live document revision is no longer this value. */
  expectedRevision?: number;
  sourceRunId?: string;
  sourceThreadId?: string;
}

export interface MemoryRemoveRequest {
  /** When set, only this exact document is removed, never a newer one at the same path. */
  id?: string;
  scope: "bot" | "user";
  botId?: string;
  path: string;
}

export interface MemoryRevision {
  id: string;
  path: string;
  revision: number;
  content: string;
}

export interface MemoryExportRequest {
  scope: "bot" | "user" | "all";
  botId?: string;
}

export interface MemoryCapabilities {
  search: boolean;
  revisions: boolean;
  markdownPortable: boolean;
}

export type DurableMemoryScope = "isolated" | "shared";

export interface SemanticMemoryCapabilities {
  recall: true;
  save: true;
  purgeHistory: true;
  sharedScope: true;
  /** Recall before every run, not only once thread history is compacted. */
  recallEachRun?: true;
  /** Never recall before a run: the bot recalls only through its memory tools. */
  recallOnRequestOnly?: true;
  /** purgeHistory removes what was learned in a chat by thread, so clearing any chat calls it. */
  purgesByThread?: true;
}

export interface SemanticMemoryResult {
  memory: string;
  score: number;
  updatedAt?: string;
  /** Stable provider id when the backend supports citation / forget. */
  id?: string;
  /** Attribution string preserved from the memory backend. */
  provenance?: string;
  /** Provider entity/namespace the fact was recalled from, when scoped. */
  entity?: string;
  /** Additional outside-source attribution. All semantic recall is derived data, even without this marker. */
  external?: true;
}

export interface SemanticMemoryForgetRequest {
  id: string;
  /** Same scope as recall: providers delete only facts inside these namespaces. */
  scope: DurableMemoryScope;
  botId: string;
  reason?: string;
  /** Entity/namespace from a prior recall citation, when the backend scopes deletes. */
  entity?: string;
}

export type SemanticMemoryResponse<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface SemanticMemoryRecallRequest {
  query: string;
  /** Automatic context excludes imported sources; explicit reads may include them. */
  includeExternal?: boolean;
  scope: DurableMemoryScope;
  botId: string;
  /** Omit until a thread has compacted history; the provider can then skip that namespace. */
  historyGeneration?: number;
  limit: number;
}

export interface SemanticMemorySaveRequest {
  content: string;
  scope: DurableMemoryScope;
  botId: string;
  source: { kind: "durable" } | { kind: "history"; generation: number };
}

export interface SemanticMemoryPurgeHistoryRequest {
  botId: string;
  threadId: string;
  generations: number[];
}

export interface SemanticMemoryConversationTurn {
  role: "user" | "assistant";
  content: string;
  /** ISO 8601. */
  timestamp: string;
  /** Who said it, when not the person or this bot: another bot in a group chat or a bot message. */
  speaker?: string;
}

/**
 * The new messages of one finished turn; earlier turns were sent before. They are data for
 * learning, including replies influenced by outside sources. Recalling the resulting knowledge
 * must preserve derived provenance rather than granting it instruction authority.
 */
export interface SemanticMemoryConversationRequest {
  botId: string;
  botName: string;
  userName: string;
  /** The bot's own chat with its person, or a group chat with other bots. */
  conversation: "direct" | "group";
  /** The bot's effective memory scope; shared also pools the turn with the Space's other bots. */
  scope: DurableMemoryScope;
  threadId: string;
  /** Thread history generation; purgeHistory with this threadId and generation removes it. */
  generation: number;
  runId: string;
  turns: SemanticMemoryConversationTurn[];
}

/** Reflects over the bot's own memory only. */
export interface SemanticMemoryReflectRequest {
  query: string;
  botId: string;
}

export type SemanticMemoryForgetResponse = SemanticMemoryResponse<{
  id: string;
  expired: boolean;
  reason: string | null;
}>;

export interface AgentInputImage {
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: Uint8Array;
}

export interface AgentSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  /**
   * Who sent it. Only the run's own person ("user") is framed as a message to answer; anything
   * else, or no origin, is passed on as a neutral note.
   */
  origin?: "user" | "member" | "messaging" | "webhook";
  /** Persisted history text before attachment paths are appended. */
  historyText?: string;
  images?: AgentInputImage[];
  /** Server verified legacy attachment bytes remain available to file tools. */
  imageFileFallback?: boolean;
}

/** Adapter-supplied cache policy metadata; absent fields mean unknown. */
export type CacheCapabilities = ConnectionCacheCapabilities;

export interface AgentRunModel {
  /** Server-side spending authorization, carried with the resolved credential. */
  callObserver?: ModelCallObserver;
  cacheCapabilities?: CacheCapabilities;
  provider: string;
  id: string;
  /** Opaque id of the stored connection serving it, so a model can fall back to another account. */
  connectionId?: string;
  apiKey?: string;
  /** Cloudflare account id stored with a gateway BYOK credential. */
  accountId?: string;
  /** Cloudflare AI Gateway id stored with a gateway BYOK credential. */
  gatewayId?: string;
  baseUrl?: string;
  apiProtocol?: ModelApiProtocol;
  headers?: Record<string, string>;
  /** The connection owner may reach a private or loopback `baseUrl`; absent means deny. */
  allowPrivateEndpoint?: boolean;
  /** Whether this custom connection accepts standard reasoning_effort. */
  reasoning?: boolean;
  /** Whether this custom connection accepts image input. */
  acceptsImages?: boolean;
  /** Maximum number of image inputs the model connection accepts in one request. */
  maxImagesPerPrompt?: number;
  /** Maximum completion tokens sent to the model endpoint. */
  maxTokens?: number;
  /** Generic connection context window, overriding catalog limits when configured. */
  contextWindow?: number;
  /** Preferred thinking effort for reasoning models; clamped to the model’s supported set. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  /** In-process OAuth credential from the encrypted store for this run. */
  oauth?: {
    credential: AgentModelOAuthCredential;
    persist?: (credential: AgentModelOAuthCredential) => Promise<void>;
    /**
     * Refreshes the stored credential under the lock every refresh of it shares,
     * calling `refresh` on the stored copy only if no other refresh already rotated it.
     */
    refresh?: (
      held: AgentModelOAuthCredential,
      refresh: (
        stored: AgentModelOAuthCredential,
        signal: AbortSignal,
      ) => Promise<AgentModelOAuthCredential | undefined>,
    ) => Promise<AgentModelOAuthCredential>;
    /** Drop the stored credential after a terminal provider rejection. */
    retire?: (
      reason: ModelCredentialRetireReason,
      detail?: string,
      failed?: ModelCredentialFailedState,
    ) => Promise<boolean | undefined>;
  };
}

export type AgentContextStrategy = "current" | "retrieval" | "snapshots" | "cache-aware";
export const DEFAULT_CONTEXT_STRATEGY: AgentContextStrategy = "retrieval";

export interface AgentRunRequest {
  /** Awaited producer-side accounting, independent of event-consumer cancellation. */
  onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => void | Promise<void>;
  contextStrategy?: AgentContextStrategy;
  /**
   * MCP servers that must return tool results whole. Direct tools match `slugs`
   * (`mcp__<slug>__<tool>`); catalog calls match `ids` (`<server id>:<tool>`).
   */
  verbatimMcpServers?: { ids: readonly string[]; slugs: readonly string[] };
  /** Exclusive workflow cost bucket; retrieval tool turns are detected for answer calls. */
  usageOperationKind?: UsageOperationKind;
  botId: string;
  threadId: string;
  runId: string;
  routineId?: string | null;
  sourceMessageId?: string | null;
  prompt: string;
  /**
   * Group threads and shared spaces: the label the model sees on the prompt, the same as on
   * history ("User", or the person's name in a space several people share).
   */
  promptSpeaker?: string;
  instructions: string;
  history: Array<{
    id?: string;
    createdAt?: string;
    role: "user" | "assistant" | "system";
    content: string;
    /**
     * Who wrote this message when it is neither this bot nor the human of a personal direct chat:
     * another bot's current name, or the person: "User", or their name in a space several people
     * share. The runtime shows such a message to the model as a user turn that starts with
     * "[speaker]: ".
     */
    speaker?: string;
    /**
     * This bot's own reply in order, its tool steps apart from its text, set when it used
     * tools. A runtime that can replay tool calls reads it instead of `content`.
     */
    segments?: Array<{ text: string } | { steps: HistoryToolStep[] }>;
    /** Images attached to this message, hydrated only for recent user turns. */
    images?: AgentInputImage[];
  }>;
  currentTurnImages?: AgentInputImage[];
  /** A confirmed image belongs to this run, including a resumed waiting-input reply. */
  currentRunRequiresImageInput?: boolean;
  /** Server verified legacy attachment bytes remain available to file tools. */
  currentTurnImageFileFallback?: boolean;
  tools: ConnectorTool[];
  model: AgentRunModel;
  /** Optional explicitly authenticated vision target for same-run computer mode. */
  computerModel?: AgentRunModel;
  /** Ordered, user-selected models eligible after provider unavailability. */
  fallbackModels?: Array<Pick<AgentRunModel, "provider" | "id" | "connectionId">>;
  /** Resolve one configured backup lazily so healthy primary turns do no extra auth work. */
  resolveFallbackModel?: (
    provider: string,
    modelId: string,
    connectionId?: string,
  ) => Promise<AgentRunModel>;
  /** Persist the selected backup against the active run lease before requesting it. */
  /** `computerMode` is set when the switch enters computer mode rather than changing the run's model. */
  onModelChange?: (provider: string, modelId: string, computerMode?: boolean) => Promise<void>;
  /** Resolve an explicitly requested helper model within the active user and space scope. */
  resolveModel?: (provider: string, modelId: string) => Promise<AgentRunModel>;
  resumeFromCheckpoint?: string;
  /** Opaque runtime transcript, persisted only on the server. */
  turnCheckpoint?: string;
  /** Cheap per-call capture; serialize only when persisting that call’s human pause. */
  onCheckpoint?: (capture: () => string, executionId: string) => Promise<void>;
  /** Human answer or takeover outcome for the pending interaction. Never secret input. */
  resumeToolResult?: { content: Array<{ type: "text"; text: string }> };
  script?: ScriptedTurn[];
  /**
   * FYI bot-message wakes and scheduled routines may finish with no text.
   * When set, skip synthetic empty-turn fallbacks (including after tools).
   */
  allowSilentEmpty?: boolean;
  /** Contextual fallback when a non-silent run produces no written response. */
  emptyResponseText?: string;
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    executionId: string,
    route?: ConnectorRoute,
    observer?: AgentToolExecutionObserver,
  ) => Promise<unknown>;
  /** Called after a tool returns; implementations must not persist raw result contents. */
  onToolCompleted?: (completion: AgentToolCompletion) => Promise<void> | void;
  /** Atomically claim durable user steering at the runtime's next safe turn boundary. */
  claimSteering?: (seenIds: string[]) => Promise<AgentSteeringMessage[]>;
  /**
   * Known run secret values, live for the run. The runtime redacts them from a tool
   * argument that is kept outside the tool call itself (the ask card's detail) before
   * any copy of it is stored, recorded or replayed.
   */
  secrets?: readonly string[];
}

export interface ScriptedTurn {
  assistant?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  ask?: { text: string; detail?: string; actions?: Array<{ id: string; label: string }> };
  takeover?: { reason: string };
  files?: Array<{ path: string; content: string }>;
  memory?: Array<{ scope: "bot" | "user"; path: string; content: string }>;
  complete?: boolean;
}

/** Provider-neutral per-call measurements. Null means unavailable, never free/zero.
 * Input excludes cache buckets. Reasoning is already included in output.
 */
export interface AgentUsage {
  providerRequestId?: string | null;
  operationKind?: UsageOperationKind;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  costSource?: string | null;
  pricingVersion?: string | null;
  pricingSnapshot?: Record<string, unknown> | null;
  usageSource?: string | null;
  /** Our own count for a call that reached the provider but ended without a reported cost,
   * deliberately low. `ifStopped` is a full count for an aborted call, priced at full rates when
   * the user stopped its run, so stopping a call is never a discount.
   */
  countedTokens?: {
    inputTokens: number;
    outputTokens: number;
    ifStopped?: { inputTokens: number; outputTokens: number };
  } | null;
}

export type UsageOperationKind = "answer" | "setup" | "retrieval" | "subagent" | "compaction";

export interface ModelCallObserver {
  beforeCall(call: {
    callId?: string;
    runId?: string;
    operationKind?: UsageOperationKind;
    provider: string;
    modelId: string;
    inputTokensEstimate: number;
    maxOutputTokens: number;
    /** Conservative dollar bound from the resolved model pricing; absent means unknown. */
    maxCostUsd?: number;
    /** Explicit adapter-known write bucket required by this request, not a billing prediction. */
    cacheWriteRetention?: "1h";
  }): string | Promise<string>;
  afterCall(reservationId: string, usage: AgentUsage | null): void | Promise<void>;
  onRequestId?(reservationId: string, providerRequestId: string): void | Promise<void>;
}

export type AgentRuntimeEvent =
  | { type: "text"; text: string }
  /** Explicit provider reasoning lifecycle only; never contains reasoning text. */
  | { type: "thinking"; active: boolean }
  /** A new assistant message starts; its text does not continue the previous text. */
  | { type: "turn" }
  /** Messages sent while the bot worked were handed to the model before this turn. */
  | {
      type: "steered";
      /** At least one came from the run's own person, in the app or a connected chat. */
      fromRunUser: boolean;
    }
  | {
      type: "progress";
      text: string;
      /** Provider-generated tool status rather than assistant-authored narration. */
      activity?: true;
    }
  | {
      type: "tool";
      name: string;
      args: Record<string, unknown>;
      executionId: string;
      /** The model reached this deferred built-in through use_tool. */
      viaUseTool?: boolean;
      /** Which model response made the call; calls from one response share it. */
      response?: number;
    }
  | {
      type: "ask";
      executionId?: string;
      text: string;
      detail?: string;
      actions?: Array<{ id: string; label: string }>;
    }
  | { type: "takeover"; reason: string; executionId?: string }
  | ({
      type: "usage";
      /** Producer-side onUsage completed; consumers must not account it again. */
      accounted?: boolean;
      provider: string;
      model: string;
      callId?: string;
      operationKind?: UsageOperationKind;
      agentId?: string;
    } & AgentUsage)
  | { type: "checkpoint"; blob: string }
  | {
      type: "subagent";
      agentId: string;
      name: string;
      task: string;
      status: "running" | "completed" | "failed";
      progress?: string;
      result?: string;
    }
  | { type: "done"; text?: string };

export interface AgentRuntimeCapabilities {
  streaming: boolean;
  compaction: boolean;
  tools: boolean;
  scripted: boolean;
}

export interface VoiceInfo {
  id: string;
  label: string;
  description?: string;
}

export interface SpeechClip {
  bytes: Uint8Array;
  mimeType: "audio/mpeg" | "audio/wav" | "audio/ogg";
}

export interface VoiceCapabilities {
  catalog: boolean;
  synthesize: boolean;
  transcribe: boolean;
  /** The provider can filter its listed voices by language. */
  languages?: boolean;
}

export interface VoiceVerifyResult {
  ok: boolean;
  message?: string;
  /** Set when the provider refused the account, as a request with the key would be. */
  code?: VoiceAccountErrorCode;
}

export interface VoiceSynthesizeRequest {
  text: string;
  voiceId: string;
  apiKey: string;
  /**
   * Connection speech model, for providers whose catalog entry sets `speechModel`. Without
   * one, each adapter uses its own default.
   */
  model?: string;
  signal?: AbortSignal;
}

export interface VoiceTranscribeRequest {
  audio: Uint8Array;
  mimeType: string;
  apiKey: string;
  /**
   * Language of the recording, as a BCP-47 tag or an ISO 639-1 code. Providers treat it
   * as a hint: Fish Audio guesses when it is missing, and a wrong guess turns speech in
   * one language into lookalike words of another.
   */
  language?: string;
  signal?: AbortSignal;
}

export interface BackgroundJobPayloads {
  "run.continue": { runId: string };
  "routine.wakeup": { routineId: string; scheduledFor: string };
  /** Run a failed routine run once more; the payload names the failed run. */
  "routine.retry": { runId: string };
  "computer.sleep": { computerId: string };
  "computer.update": { updateId: string };
  "computer.control-expire": { computerId: string; leaseId: string };
  "skill.teaching-expire": { skillId: string };
  /** The bot's call rang out: mark it missed if nobody answered. */
  "call.expire": { threadId: string; callId: string };
  "history.compact": { threadId: string; userId?: string };
  /** Retry a failed post-clear purge without relying on deleted thread/run rows. */
  "memory.purge-history": {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    generations: number[];
    connectionIdentity: string;
  };
  /**
   * `messageIds`: what the person sent while the run worked, which the run also answered.
   * `pending`: cleanup captured before submission. `unconfirmed` keeps checking through the
   * cleanup window if the submission response was lost; otherwise poll the provider token until
   * settled, or just retry the purge when no token is needed. Purge the captured generation if
   * the chat was cleared. `checks` bounds the window. Captured source identifiers survive group
   * deletion; connectionIdentity prevents a replacement from handling the old operation.
   */
  "memory.retain-turn": {
    runId: string;
    messageIds?: string[];
    pending?: {
      token?: string;
      /** Submission may have started but its response was not durably handed off. */
      unconfirmed?: true;
      generation: number;
      checks: number;
      connectionIdentity: string;
      source: { spaceId: string; userId: string; botId: string; threadId: string };
    };
  };
  /** Backup for one recorded outgoing chat message, and the conversation queued behind it. */
  "messaging.send": { outboundId: string };
  /** Backup for recording and sending what an ended run said where its turn came from. */
  "messaging.reply": { runId: string };
  /** The previous release's outbox drain; drained by the new delivery path. */
  "messaging.deliver": { runId?: string };
  /** The previous release's interim-message mirror; drained by the new delivery path. */
  "messaging.progress": { runId: string };
  "messaging.credential-cleanup": { installationId: string; ref: string };
  /** Backup for answering one inbound team-chat message, and the end of its routine routing. */
  "team_chat.engage": { externalMessageId: string };
  /** Decide whether a conversation's unanswered team-chat messages need the bot. */
  "team_chat.ambient": { conversationId: string };
  /** Reconcile durable remote-agent intent; scope is loaded from the database. */
  "cloud_agent.poll": { agentId: string };
  "purchase.poll": { purchaseId: string };
  /** Check a submitted video and post it when ready; the ID is the bot-visible job ID. */
  "media.poll": { jobId: string };
  /** Read an Expo push receipt; the token is identified by its digest, never stored. */
  "push.receipt": { userId: string; ticketId: string; tokenDigest: string };
}

export type BackgroundJobName = keyof BackgroundJobPayloads;

export type BackgroundJob = {
  [Name in BackgroundJobName]: {
    name: Name;
    payload: BackgroundJobPayloads[Name];
    availableAt?: Date;
    replaceKey?: string;
    /**
     * Leave an existing job with `replaceKey` alone while it still has attempts
     * left, including one waiting out backoff. An exhausted or missing job is
     * replaced. Omit to replace, which is what an explicit continue does.
     */
    keepExisting?: boolean;
    /**
     * With `keepExisting`, still replace a job a worker locked at or before this
     * time. A worker that died never unlocks its job, so it would never run again.
     */
    replaceLockedBefore?: Date;
    /** Cap retried executions; omit to use the job queue's default. */
    maxAttempts?: number;
    /** Jobs sharing a queue run one at a time, in order. */
    queueName?: string;
  };
}[BackgroundJobName];

export interface BackgroundJobExecution {
  /** Release the dispatch slot only after durable run ownership and heartbeat setup. */
  onRunStarted(): void;
}

/** Which try this is, for a handler that settles its work differently on the last one. */
export interface BackgroundJobAttempt {
  number: number;
  max: number;
}

export type BackgroundJobHandlers = {
  [Name in BackgroundJobName]: (
    payload: BackgroundJobPayloads[Name],
    execution?: BackgroundJobExecution,
    attempt?: BackgroundJobAttempt,
  ) => Promise<void>;
};

export interface SecretRecord {
  id: string;
  /** Opaque reference; persisted in the existing ciphertext column. */
  ref: string;
  ciphertext: string;
}

export type SecretContext = string | { recordId: string; signal?: AbortSignal };
export interface SecretPutOptions {
  recordId?: string;
  ephemeral?: boolean;
}
export type SecretChangeListener = (ref: string) => void;

export interface ArtifactPut {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface NotificationMessage {
  /**
   * Verified sender metadata. `avatar` is a bounded thumbnail at most 96px, base64 encoded;
   * `avatarLarge` is the same drawing at up to 120px for devices that draw the sender larger
   * than Android's 96px limit, when one fits the payload budget.
   */
  sender?: { botId: string; name: string; avatar?: string; avatarLarge?: string };
  kind: "completion" | "failure" | "help" | "takeover";
  title: string;
  body: string;
  botId: string;
  threadId: string;
  /** The finished run, so a device that also polls for finished work does not alert twice. */
  runId?: string;
  /** Group chat that owns threadId, so a tap does not open the bot's direct thread. */
  groupId?: string;
  /** Unread chats to show on the app icon, when the sender knows them. */
  badge?: number;
}

/** A product-authored transactional email, independent of its delivery vendor. */
export interface TransactionalEmail {
  to: string | string[];
  /** Sends as this address, such as a bot's own, instead of the provider's configured one. */
  from?: string;
  cc?: string[];
  /** Where replies go, instead of the provider's configured reply-to address. */
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

export type MessagingReceipt = "typing" | "reaction";

export interface MessagingCapabilities {
  direct: boolean;
  groups: boolean;
  receipt: MessagingReceipt | null;
  /** Sends image and file attachments. Absent means replies go out as text only. */
  files?: boolean;
}

/** One messaging platform behind the chat surface (sendblue, slack, …). */
export interface MessagingPlatformDescriptor {
  provider: string;
  capabilities: MessagingCapabilities;
  /** The line people message to reach this deployment (a phone number), when it has one. */
  address?: string;
}

/** Send into an existing conversation, addressed by its opaque thread id. */
export interface MessagingSendRequest {
  threadId: string;
  body: string;
  /** Stable key so retries of the same logical send can be deduped upstream. */
  idempotencyKey?: string;
  /** A file to post as this message; only sent to platforms with the `files` capability. */
  attachment?: MessagingOutboundAttachment;
}

/** An outbound file, already read from the artifact store. */
export interface MessagingOutboundAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface MessagingSendResult {
  handle: string;
}

/** Provider-neutral inbound message after platform webhook parsing. */
export type TeamChatMessageKind = "direct" | "mention" | "ambient";

export interface MessagingInboundMessage {
  type: "message";
  provider: string;
  /** Per-message transport when one provider spans multiple networks (for example SMS vs RCS). */
  transport?: string;
  /** Provider message id; drives replay-safe client nonces downstream. */
  handle: string;
  /** Opaque conversation id — pass back to sendToThread to reply. */
  threadId: string;
  /** True for a 1:1 conversation with the deployment's line/bot. */
  isDirect: boolean;
  /** Sender address within the provider (E.164, Slack user id, …). */
  from: string;
  /** Sender display name when the platform provides one. */
  fromLabel: string | null;
  /** Group/channel display name; null for DMs or when unknown. */
  channelName: string | null;
  /** Group roster addresses when the platform reports them; often empty. */
  participants: string[];
  /**
   * When the platform says this roster was current, when it reports a time for
   * the event; a roster older than the newest one already processed for the
   * channel changes no membership.
   */
  rosterAt?: Date;
  /**
   * Member departures this event reports one at a time (Telegram service
   * messages on a platform that sends no roster): addresses that left or were
   * removed, plus our own bot leaving, which ends every membership because
   * nothing more can be delivered to that channel.
   */
  departures?: { addresses: string[]; botLeft: boolean };
  content: string;
  mediaUrl: string | null;
  /** Files the platform only serves to the bot's credentials (Slack url_private, …). */
  attachments?: MessagingInboundAttachment[];
  /** The platform reports that this group message @-mentions the bot. */
  mentionsBot?: boolean;
  /** Team-room workspace/team id when the platform reports one (Slack team_id, …). */
  workspaceId?: string;
  /** Trusted installation owner, attached only after webhook verification. */
  installationId?: string;
  installationSpaceId?: string;
  installationBotId?: string;
  /** Stable conversation key within the workspace (channel id, DM key, …). */
  conversationKey?: string;
  /** How this message should engage the team-chat bot. */
  kind?: TeamChatMessageKind;
  /** Provider thread id for in-channel replies (Slack thread_ts); null for channel root. */
  replyThreadId?: string | null;
  senderIsBot?: boolean;
  /** Display names for room participants when the platform reports them. */
  participantNames?: string[];
}

/** An inbound file whose bytes are fetched with the platform's own credentials. */
export interface MessagingInboundAttachment {
  name: string;
  mimeType: string;
  /** Size the platform reported, when known. */
  size?: number;
  fetch: () => Promise<Uint8Array>;
}

/** Provider-neutral inbound team/external room message for TeamChatBridge. */
export interface TeamChatInboundMessage {
  eventId: string;
  workspaceId: string;
  kind: TeamChatMessageKind;
  conversationType?: "im" | "channel" | "group" | "mpim";
  conversationKey: string;
  /** Messaging threadId used with sendToThread. */
  conversationId: string;
  conversationName?: string;
  participantNames?: string[];
  replyThreadId: string | null;
  senderId: string;
  senderName: string;
  senderIsBot?: boolean;
  content: string;
  attachments?: MessagingInboundAttachment[];
}

export interface TeamChatSendRequest {
  conversationId: string;
  replyThreadId: string | null;
  content: string;
  idempotencyKey?: string;
}

export interface TeamChatSendResult {
  handle: string;
}

/** Provider-neutral outbound delivery status after platform webhook parsing. */
export interface MessagingOutboundStatus {
  type: "status";
  provider: string;
  handle: string;
  status: string;
}

export type MessagingInboundEvent = MessagingInboundMessage | MessagingOutboundStatus;

export interface WebSearchCapabilities {
  search: boolean;
  /** True when results come from the active model’s native search, not a third-party API. */
  native?: boolean;
  /** True when search works without a hosted search vendor or API key. */
  keyless?: boolean;
}

export interface WebFetchCapabilities {
  fetch: boolean;
  /** True when readable extraction runs without executing page JavaScript. */
  readability: boolean;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebFetchRequest {
  url: string;
  maxChars?: number;
  /** Characters of page text to skip, to read on after a truncated fetch. */
  offset?: number;
  signal?: AbortSignal;
}

export interface WebFetchResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Page-level browser on the bot computer (DOM refs), not a hosted browser vendor. */
export interface BrowserCapabilities {
  page: boolean;
  /** True when element refs from snapshot can be clicked or filled. */
  refs: boolean;
  /** True when the adapter runs without a hosted browser vendor or API key. */
  keyless?: boolean;
}

export interface BrowserNavigateRequest {
  url: string;
  /** Folder in the computer's home that a file download is saved to; without it, none is saved. */
  downloads?: string;
  signal?: AbortSignal;
}

/** A file the page downloaded: where it was saved, or why it was not. */
export interface BrowserDownload {
  name?: string;
  path?: string;
  /** Bytes saved, or so far while it is still downloading. */
  size?: number;
  type?: string;
  /** Still downloading when the result was sent; the file appears at `path` once it is done. */
  state?: "downloading";
  error?: string;
}

export interface BrowserNavigateResult {
  url: string;
  title: string;
  /** The page it reached, as a snapshot shows it, when that could be read in time. */
  tree?: string;
  elements?: BrowserSnapshotNode[];
  /** The page was still loading or waiting on its own requests when it was captured. */
  loading?: boolean;
  downloads?: BrowserDownload[];
  /** When set, the page tool could not operate; use computer_act instead. */
  fallback?: "computer_act";
  error?: string;
  /** What the page did that the bot should know, such as an alert that was closed. */
  note?: string;
  /** A JavaScript dialog the page has open on the screen, which page tools cannot answer. */
  dialog?: string;
}

export interface BrowserSnapshotRequest {
  /** Words to find controls by anywhere on the page, such as "newsletter signup". */
  query?: string;
  /** Folder in the computer's home that a PDF the tab shows is saved to; without it, none is saved. */
  downloads?: string;
  signal?: AbortSignal;
}

export interface BrowserSnapshotNode {
  /** Stable element ref for browser_act (e.g. e12). */
  ref: string;
  role: string;
  name: string;
  value?: string;
  tag?: string;
  /** A native select's options: what the page shows, the value it keeps, and which one is chosen. */
  options?: Array<{ label: string; value: string; selected?: boolean; disabled?: boolean }>;
  /** How many options a long select has, when only the first ones and the chosen one are listed. */
  optionsTotal?: number;
}

export interface BrowserSnapshotResult {
  url: string;
  title: string;
  /** Compact accessibility-style tree for the model. */
  tree: string;
  elements: BrowserSnapshotNode[];
  /** The page was still loading or waiting on its own requests when it was captured. */
  loading?: boolean;
  downloads?: BrowserDownload[];
  fallback?: "computer_act";
  error?: string;
  /** What the page did that the bot should know, such as an alert that was closed. */
  note?: string;
  /** A JavaScript dialog the page has open on the screen, which page tools cannot answer. */
  dialog?: string;
}

export type BrowserActKind = "click" | "fill" | "type" | "upload";

export const MAX_BROWSER_UPLOAD_FILES = 10;

export type BrowserActStep =
  /**
   * `approved`, `site`, `label`, `amount`: the user approved this click, which completes a purchase, on
   * that site, as the card showed the button and total. The click is refused if either has changed.
   */
  | {
      kind: "click";
      ref: string;
      approved?: boolean;
      site?: string;
      label?: string;
      amount?: string;
      /** The page's total the card showed beside the button, or empty when it showed none. */
      total?: string;
    }
  /** Attaches computer files to a file input without opening a native file chooser. */
  | { kind: "upload"; ref: string; paths: string[]; roots?: string[] }
  | {
      kind: "fill" | "type";
      ref: string;
      text: string;
      /** Refuse the step unless the page is on this origin when it is applied. */
      origin?: string;
      /**
       * What `text` is: a saved login's hidden field ("password", typed only into a password
       * field) or visible field ("username"), or an approved purchase's card detail. A card fill
       * always carries `origin`.
       */
      field?: "username" | "password" | "card" | "code";
    }
  | {
      kind: "fill";
      ref?: undefined;
      text: string;
      origin: string;
      field: "card";
      cardField: PurchaseCardField;
    }
  | {
      kind: "pay_token";
      ref?: undefined;
      text: string;
      origin: string;
      merchantAccountId: string;
    };

export interface BrowserActRequest {
  actions: BrowserActStep[];
  /** Folder in the computer's home that a file download is saved to; without it, none is saved. */
  downloads?: string;
  signal?: AbortSignal;
}

export interface BrowserActResult {
  ok: boolean;
  completed: number;
  /** An action may have taken effect before its response was lost. Observe before continuing. */
  uncertain?: boolean;
  url: string;
  title: string;
  /** Snapshot after the actions when available. */
  tree?: string;
  elements?: BrowserSnapshotNode[];
  /** The page was still loading or waiting on its own requests when that snapshot was taken. */
  loading?: boolean;
  downloads?: BrowserDownload[];
  fallback?: "computer_act";
  error?: string;
  /** What the page did that the bot should know, such as an alert that was closed. */
  note?: string;
  /** A JavaScript dialog the page has open on the screen, which page tools cannot answer. */
  dialog?: string;
}

/** A purchase step as the page shows it: the label and amount are page text. */
export interface BrowserPurchase {
  /** The page's host. An approval holds for this site only. */
  site: string;
  label: string;
  amount: string;
  /** Whether the amount is the one the button names or the total the page shows. */
  amountSource?: "button" | "page";
  /** The total the page shows beside a button that names its own amount; older computers omit it. */
  total?: string;
  /** The order lines the page lists above its total, as page text; none when it lists none or is older. */
  items?: BrowserPurchaseItem[];
}

/** An order line as the checkout page shows it, such as an item with its quantity, or delivery. */
export interface BrowserPurchaseItem {
  name: string;
  amount: string;
}

export interface BrowserPurchaseCheckRequest {
  /** The steps of a browser_act call; only clicks are looked at. */
  actions?: Array<{ kind: string; ref?: string }>;
  /**
   * Ask about clicks or a key on the screen, which name no element. `points` are the clicks' spots in screen
   * pixels; `enter` is a key that submits or presses the focused control.
   */
  desktop?: boolean;
  enter?: boolean;
  points?: Array<{ x: number; y: number }>;
  /** A click whose spot cannot be told (the page may have changed under it): the page decides. */
  unplaced?: boolean;
  signal?: AbortSignal;
}

/** `steps`: the indexes of the clicks that would complete the purchase. */
export interface BrowserPurchaseCheckResult {
  purchase: (BrowserPurchase & { steps: number[] }) | null;
}

/** A sandbox must route these commands through its owned screen, never generic host execution. */
export type PageBrowserCommand =
  | { command: "navigate"; url: string; downloads?: string }
  | { command: "snapshot"; query?: string; downloads?: string }
  | { command: "act"; actions: BrowserActStep[]; downloads?: string }
  | {
      command: "purchase_check";
      actions?: BrowserPurchaseCheckRequest["actions"];
      desktop?: boolean;
      enter?: boolean;
      points?: BrowserPurchaseCheckRequest["points"];
      unplaced?: boolean;
    };

export type PageBrowserResult = Partial<BrowserSnapshotResult & BrowserActResult> & {
  ok: boolean;
  /** A purchase check: the page's host, and what the purchase is as the page shows it. */
  site?: string;
  purchase?: unknown;
};

export type CloudAgentStatus = "running" | "finished" | "failed" | "cancelled" | "expired";

export interface CloudAgentCapabilities {
  launch: boolean;
  reply: boolean;
  cancel: boolean;
  /** True when the adapter never leaves the process (tests / Playwright). */
  offline?: boolean;
}

export type CloudAgentImage = { data: string; mimeType: string } | { url: string };

export interface CloudAgentLaunchRequest {
  /** Repeated launches with this key must resolve to the same remote agent. */
  idempotencyKey: string;
  prompt: string;
  repository?: string;
  images?: CloudAgentImage[];
  openPr?: boolean;
  signal?: AbortSignal;
}

export interface CloudAgentHandle {
  id: string;
  url: string;
  title: string;
  status: CloudAgentStatus;
  /** Latest remote run id when the vendor exposes one (needed for cancel). */
  latestRunId?: string;
}

export interface CloudAgentSnapshot {
  id: string;
  url: string;
  title: string;
  status: CloudAgentStatus;
  branch?: string;
  prUrl?: string;
  latestRunId?: string;
}

export interface CloudAgentReplyRequest {
  prompt: string;
  images?: CloudAgentImage[];
  signal?: AbortSignal;
}

/**
 * Optional auto-allow check for a consequential tool call. Core still runs when
 * no hosted verifier is configured; the LLM judge is the default adapter.
 */
export interface AutoReviewCapabilities {
  /** True when the adapter never leaves the process (tests / Playwright). */
  offline?: boolean;
  /** True when a hosted vendor key is not required. */
  keyless?: boolean;
}

export type AutoReviewDecision = "pass" | "ask" | "error";

export interface AutoReviewMatchingRule {
  effect: string;
  matchKind: string;
  matchValue: string;
}

export interface AutoReviewRequest {
  toolName: string;
  connectorKind: string;
  /** Caller must already redact secrets and sensitive keys. */
  args: Record<string, unknown>;
  userTask: string;
  botDescription: string;
  matchingRules: AutoReviewMatchingRule[];
  /**
   * A web_fetch to a site the run was not given. `args` is then only the full URL, and
   * `userTask` only the owner's own words (their message or the routine's instructions), never
   * tool results or inbound messages, so injected text cannot argue for the site.
   */
  newSite?: boolean;
  /**
   * A save to the bot's memory after the run took in outside content. The bot reads saved memory
   * as trusted context in every later run, so the saved text is judged as a standing instruction.
   */
  memoryWrite?: boolean;
}

export interface AutoReviewResult {
  decision: AutoReviewDecision;
  reason?: string;
  model: string;
}

/** Provider-neutral subscription state. Vendor-specific states map onto these. */
export type BillingSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "incomplete"
  /** No access; the subscription resumes from the billing portal, so a new checkout would double-bill. */
  | "unpaid"
  | "paused"
  | "canceled";

export interface BillingPrice {
  /** Minor currency units, e.g. cents. */
  amount: number;
  currency: string;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
}

export interface BillingCreditPurchase {
  /** Stable provider payment identity, including any subsequent refund adjustment. */
  id: string;
  amountCents: number;
  /** Subscription service-period end; absent for non-expiring top-ups. */
  expiresAt?: string;
}

export interface BillingCreditCheckoutRequest {
  customerId: string;
  amountCents: number;
  monthly: boolean;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingByokCheckoutRequest extends Omit<BillingCreditCheckoutRequest, "monthly"> {
  /** How often `amountCents` bills; monthly when omitted. */
  interval?: "month" | "year";
  /** Standard when omitted. */
  tier?: ByokTier;
  /** Omitted when the customer has already used its trial. */
  trialDays?: number;
}

/** Full subscription state for one billing customer, re-fetched from the provider on every sync. */
export interface BillingSubscriptionSnapshot {
  creditAmountCents?: number;
  subscriptionId: string;
  subscriptionItemId: string;
  priceId: string;
  status: BillingSubscriptionStatus;
  seats: number;
  trialEndsAt: Date | null;
  /** Start of the period being billed, or of the trial while one runs. */
  currentPeriodStartsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  endedAt: Date | null;
  /** The flat own-key plan, which grants access without credits. */
  byokPlan?: boolean;
  /** What the own-key plan bills each period, which stays at the price it was bought at. */
  byokPriceCents?: number;
  /** The own-key plan's billing period. */
  byokInterval?: "month" | "year";
  /** The own-key plan's tier, which the provider reports with the plan. */
  byokTier?: ByokTier;
  /** Stable identity of the subscription's card across customers, when the provider has one. */
  cardFingerprint?: string;
  cancellationReason?: BillingCancellationReason;
  cancellationComment?: string;
}

/** One own-key plan: its tier, how often it bills, and what it bills each period. */
export interface BillingByokPlan {
  tier: ByokTier;
  interval: "month" | "year";
  amountCents: number;
}

export interface BillingCheckoutRequest {
  customerId: string;
  seats: number;
  /** Omitted when the customer has already used its trial. */
  trialDays?: number;
  successUrl: string;
  cancelUrl: string;
}

/** Optional provider adapter for recovering authoritative cost after an interrupted call. */
export interface ModelUsageLookup {
  provider: string;
  lookupUsage(providerRequestId: string): Promise<AgentUsage | null>;
}
