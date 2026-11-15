import type { ComputerSize } from "@rakazo/contracts";
import type {
  AdapterContext,
  AdapterDescriptor,
  AgentRunRequest,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  ArtifactPut,
  AutoReviewCapabilities,
  AutoReviewRequest,
  AutoReviewResult,
  BackgroundJob,
  BackgroundJobHandlers,
  BillingByokCheckoutRequest,
  BillingByokPlan,
  BillingCheckoutRequest,
  BillingCreditCheckoutRequest,
  BillingCreditPurchase,
  BillingPrice,
  BillingSubscriptionSnapshot,
  BrowserActRequest,
  BrowserActResult,
  BrowserCapabilities,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserPurchaseCheckRequest,
  BrowserPurchaseCheckResult,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  CloudAgentCapabilities,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ConnectorCall,
  ConnectorCapabilities,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ControlLeaseRef,
  MemoryCapabilities,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRemoveRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSendResult,
  NotificationMessage,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxCapabilities,
  ScreenRequest,
  ScreenSession,
  SecretChangeListener,
  SecretContext,
  SecretPutOptions,
  SecretRecord,
  SemanticMemoryCapabilities,
  SemanticMemoryConversationRequest,
  SemanticMemoryForgetRequest,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryReflectRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
  SnapshotRef,
  SpeechClip,
  StreamedPortableFile,
  TerminalRequest,
  TransactionalEmail,
  VoiceCapabilities,
  VoiceInfo,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
  WebFetchCapabilities,
  WebFetchRequest,
  WebFetchResult,
  WebSearchCapabilities,
  WebSearchHit,
  WebSearchRequest,
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "./types.js";

export interface SandboxProvider {
  /** Providers tied to one external desktop reject references belonging to another connection. */
  ownsReference?(computer: Pick<ComputerRef, "kind" | "providerRef">): boolean;
  /** True when every running minute is billed, so the active-lifetime cap applies. */
  billsWhileRunning?(computer: Pick<ComputerRef, "kind">): boolean;
  /** Whether the provider running this computer keeps its disk when it stops. */
  keepsHome?(computer: ComputerRef): Promise<boolean>;
  describe(): AdapterDescriptor<SandboxCapabilities>;
  /** Workspace directory operations for hosts without the standard Unix command tools. */
  workspaceDirectories?(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ): Promise<string[]>;
  /** Native command environment; omitted for providers with a fixed container environment. */
  environment?(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<{ platform: string; home: string; shell: string } | undefined>;
  /** Optional live browser on the same leased screen as observe/act. */
  pageBrowser?(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult>;
  /** Allocate or reconnect the computer, returning its reference before fallible setup. */
  provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
      /**
       * When the saved workspace a replacement would restore was read from the computer. A
       * provider that can only bring `providerRef` back from an older snapshot of its own
       * reports it gone instead, so the newer save wins.
       */
      savedAt?: Date;
      /**
       * The size to start at. A computer already running keeps its size; without one, a stopped
       * computer resumes at its current size and a new one starts at the standard size. A size
       * the provider cannot move to throws `SandboxSizeUnavailableError`.
       */
      size?: ComputerSize;
      /**
       * The owner's IANA time zone (`Europe/Warsaw`) and app language (`pl`, `pt-BR`), for the
       * computer's clock and browser. Absent when unknown: the provider keeps its defaults.
       * Values are not validated here; a provider ignores one it cannot use.
       */
      timezone?: string;
      language?: string;
    },
    context: AdapterContext,
  ): Promise<ComputerRef>;
  /**
   * The kind provision() would return now, without starting anything. Only providers that
   * choose between kinds at provision time implement it. `homeKey` names the computer when the
   * choice can depend on whose it is.
   */
  provisionKind?(homeKey?: string): Promise<ComputerRef["kind"]>;
  /**
   * Read-only probe that never starts or resumes anything. Resolves true only when the provider
   * reports this exact reference running, and false only when it reports it not running or gone;
   * throws when it cannot tell.
   */
  isRunning?(computer: ComputerRef, context: AdapterContext): Promise<boolean>;
  /**
   * Read-only probe: true only when the provider already holds this reference stopped with its
   * disk kept, so it resumes as it was without anything running now.
   */
  isStopped?(computer: ComputerRef, context: AdapterContext): Promise<boolean>;
  /** True only when this computer currently mounts the server's home directory. */
  hasMountedHome?(computer: ComputerRef, context: AdapterContext): Promise<boolean>;
  /** Perform idempotent provider setup after the lifecycle has captured the reference. */
  prepare(computer: ComputerRef, context: AdapterContext): Promise<void>;
  execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent>;
  /** Cancel only this run’s native commands; other providers may use a sandbox-scoped fallback. */
  cancelRunWork?(
    computer: ComputerRef,
    computerId: string,
    runId: string,
    context: AdapterContext,
  ): Promise<void>;
  inspectBackgroundWork?(
    computer: ComputerRef,
    markerId: string,
    context: AdapterContext,
  ): Promise<"active" | "idle" | "unknown">;
  connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession>;
  /** Open a user shell bound to the current control lease; it closes when control is released. */
  connectTerminal?(
    computer: ComputerRef,
    request: TerminalRequest,
    context: AdapterContext,
  ): Promise<{ url: string; headers?: Record<string, string> }>;
  setScreenControl?(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void>;
  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void>;
  observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation>;
  act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult>;
  listFiles(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]>;
  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array>;
  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext): Promise<void>;
  /** Large files may come as streams. A provider that lists first refuses `limits` up front. */
  exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ): AsyncIterable<PortableFile | StreamedPortableFile>;
  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void>;
  snapshot(computer: ComputerRef, context: AdapterContext): Promise<SnapshotRef>;
  keepAlive?(computer: ComputerRef): Promise<void>;
  /** Drop a single-screen graphical claim for this bot so another Team bot can use the display. */
  releaseScreen?(computer: ComputerRef, context: AdapterContext): Promise<void>;
  /**
   * Stops the computer, keeping its disk where the provider can. `discardUnsaved` says nothing on
   * the computer can be read anymore: a provider that refuses to stop because it cannot save the
   * disk first stops anyway, keeping its last good copy.
   */
  stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ): Promise<void>;
  destroy(computer: ComputerRef, context: AdapterContext): Promise<void>;
}

export interface ConnectorProvider {
  describe(): AdapterDescriptor<ConnectorCapabilities>;
  discoverTools(context: AdapterContext): Promise<ConnectorTool[]>;
  /** Resolve a lazy catalog call to its authoritative authorized tool before approval. */
  resolveCall?(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined>;
  execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent>;
  /** Release run-scoped state (open sessions) of a run that ended for good on
   * this worker. A run that ended elsewhere is bounded by the provider itself. */
  endRun?(runId: string): void;
}

export interface ConnectionAuthProvider {
  describe(): AdapterDescriptor<{ oauth: boolean }>;
  begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }>;
  complete(
    request: { state: string; code?: string },
    context: AdapterContext,
  ): Promise<{ connectionRef: string }>;
  revoke(connectionRef: string, context: AdapterContext): Promise<void>;
}

/** A connector that also owns an end-user app catalog and connection lifecycle. */
export interface ManagedConnectorProvider
  extends ConnectorProvider,
    Omit<ConnectionAuthProvider, "describe"> {
  catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]>;
  /** The actions one app offers, to show people what connecting it gives bots. */
  listAppTools?(context: AdapterContext, externalId: string): Promise<ConnectorTool[]>;
  listConnectedExternalIds(context: AdapterContext): Promise<string[]>;
  /** Whether a connected app needs reconnecting because its saved connection gives this run no tools. */
  needsReconnect?(context: AdapterContext, externalId: string): Promise<boolean>;
  /** Connection refs the provider reports as dead until the user reconnects them. */
  listReconnectRefs?(context: AdapterContext): Promise<string[]>;
  connectionReady(context: AdapterContext, externalId: string): Promise<boolean>;
  warmDirectory?(): Promise<void>;
  /** Map a begin() state or stored ref to the concrete remote account id, skipping excluded ids. */
  resolveConnectedAccountId?(
    userId: string,
    slug: string,
    currentRef: string | null | undefined,
    excludeIds?: string[],
    spaceId?: string,
  ): Promise<string | undefined>;
  /** Invalidate an unfinished browser authorization by its request id. */
  cancelAuthorizationRequest?(requestId: string, context: AdapterContext): Promise<void>;
  /** Delete remote accounts for `slug` that no local row still references. */
  revokeUnreferencedAccounts?(
    slug: string,
    keepAccountIds: string[],
    context: AdapterContext,
  ): Promise<void>;
}

export interface MemoryStore {
  describe(): AdapterDescriptor<MemoryCapabilities>;
  read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot>;
  search(request: MemorySearchRequest, context: AdapterContext): Promise<MemorySearchResult[]>;
  commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision>;
  /** Delete one document and its history; `removed` is false when nothing matched. */
  remove(request: MemoryRemoveRequest, context: AdapterContext): Promise<{ removed: boolean }>;
  exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile>;
  importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision>;
}

/** Optional semantic memory. Durable Markdown memory remains owned by MemoryStore. */
export interface SemanticMemoryProvider {
  /** Required by retainConversation: an opaque version that changes with endpoint or credentials. */
  readonly connectionIdentity?: string;
  describe(): AdapterDescriptor<SemanticMemoryCapabilities>;
  recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>>;
  save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse>;
  purgeHistory(
    request: SemanticMemoryPurgeHistoryRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse>;
  /** Optional durable forget. Providers without a forget verb omit this. */
  forget?(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>>;
  /**
   * Optional: learn from one finished turn of a bot's conversation. Resolves once the turn is
   * submitted. `pending` is an opaque token while the provider is still storing it: poll
   * `retainedConversationSettled` with it until settled, so a purgeHistory after that removes the
   * turn. A provider that can return `pending` must implement `retainedConversationSettled`.
   */
  retainConversation?(
    request: SemanticMemoryConversationRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ pending?: string }>>;
  /** Optional: whether a turn `retainConversation` answered with `pending` is stored now. */
  retainedConversationSettled?(
    pending: string,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ settled: boolean }>>;
  /** Optional: answer a question by reasoning over the bot's memory. */
  reflect?(
    request: SemanticMemoryReflectRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<string>>;
}

export interface AgentRuntime {
  describe(): AdapterDescriptor<AgentRuntimeCapabilities>;
  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent>;
  abort(runId: string): Promise<void>;
}

export interface ModelProvider {
  describe(): AdapterDescriptor<{ catalog: boolean; byok: boolean }>;
  listModels(): Promise<Array<{ provider: string; id: string; label: string; billing: string }>>;
}

/** An open database transaction a job can be written in, so the job exists only if it commits. */
export interface JobTransaction {
  $executeRawUnsafe(query: string, ...values: unknown[]): PromiseLike<unknown>;
}

export interface JobPublisher {
  enqueue(job: BackgroundJob): Promise<void>;
  /** Adds the job, or replaces the one with its key, as part of the caller's transaction. */
  enqueueIn(tx: JobTransaction, job: BackgroundJob): Promise<void>;
  /** Removes the keyed job as part of the caller's transaction. */
  cancelIn(tx: JobTransaction, key: string): Promise<void>;
  cancel(key: string): Promise<void>;
  close(): Promise<void>;
}

export interface JobWorkerHost {
  start(handlers: BackgroundJobHandlers): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentHomeStore {
  describe(): AdapterDescriptor<{ revisions: boolean }>;
  checkout(botId: string, dest: string, context: AdapterContext): Promise<string>;
  commit(botId: string, src: string, context: AdapterContext): Promise<string>;
  restore(botId: string, revision: string, dest: string, context: AdapterContext): Promise<void>;
  /**
   * Paths are relative to `directory`; a missing or linked directory exports nothing.
   * `skipHidden` leaves out hidden entries at the top of the directory, also behind links.
   */
  exportHome(
    botId: string,
    context: AdapterContext,
    options?: { directory?: string; skipHidden?: boolean },
  ): AsyncIterable<PortableFile>;
  readFile(
    botId: string,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<string>;
  writeFile(botId: string, path: string, content: string, context: AdapterContext): Promise<void>;
  list(
    botId: string,
    path: string,
    context: AdapterContext,
  ): Promise<Array<{ path: string; kind: "file" | "dir"; size: number }>>;
}

/**
 * A bucket of opaque objects on an S3-compatible service (or a test fake). Only the API and
 * worker hold one; sandboxes never receive its credentials or object URLs.
 */
export interface ObjectStorage {
  /** Writes the whole stream as one object, replacing any object with that key. */
  put(key: string, body: AsyncIterable<Uint8Array>): Promise<void>;
  /** Throws when the object does not exist. */
  get(key: string): AsyncIterable<Uint8Array>;
  list(prefix: string): AsyncIterable<{ key: string; lastModified: Date }>;
  /** Missing keys are not an error. */
  delete(keys: readonly string[]): Promise<void>;
}

/** Identifies the data key being wrapped; implementations bind it into the wrap. */
export interface KeyWrapContext {
  spaceId: string;
  version: number;
}

export interface WrappedDataKey {
  masterKeyId: string;
  wrappedKey: string;
}

/**
 * Wraps per-space data keys under master keys it never reveals. The local
 * implementation reads master keys from the environment; a KMS or secret
 * manager adapter implements the same contract.
 */
export interface KeyProvider {
  describe(): AdapterDescriptor<{ rotate: boolean }>;
  /** Master key that new wraps use. Older ids stay valid for unwrap. */
  activeKeyId(): string;
  wrap(dataKey: Uint8Array, context: KeyWrapContext): Promise<WrappedDataKey>;
  unwrap(wrapped: WrappedDataKey, context: KeyWrapContext): Promise<Uint8Array>;
}

export interface ArtifactStore {
  describe(): AdapterDescriptor<{ stream: boolean }>;
  put(artifact: ArtifactPut, context: AdapterContext): Promise<{ id: string; hash: string }>;
  get(id: string, context: AdapterContext): Promise<Uint8Array>;
  remove(id: string, context: AdapterContext): Promise<void>;
}

export interface SecretStore {
  describe(): AdapterDescriptor<{ rotate: boolean; degraded?: boolean }>;
  put(
    plaintext: string,
    context: AdapterContext,
    options?: SecretPutOptions,
  ): Promise<SecretRecord>;
  load(ref: string, context: SecretContext): Promise<string>;
  /** Inline encrypted refs have no remote resource; removal is owned by persistence. */
  delete(ref: string, context: SecretContext): Promise<void>;
  redact(value: string): string;
  onChange(listener: SecretChangeListener): () => void;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeFanout {
  describe(): AdapterDescriptor<{ distributed: boolean; push: boolean }>;
  publish(topic: string, payload: string): Promise<void>;
  subscribe(topic: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export type IncomingCallNotification = {
  callId: string;
  botId: string;
  botName: string;
  expiresAt: string;
  /** Stops a ring that is still going on Android devices for a call settled elsewhere. */
  ended?: true;
};

export interface NotificationProvider {
  describe(): AdapterDescriptor<{ push: boolean; email: boolean }>;
  send(message: NotificationMessage, context: AdapterContext): Promise<void>;
  incomingCall?(userId: string, call: IncomingCallNotification): Promise<void>;
}

/** Outbound account and security email. Product code owns content; adapters own delivery. */
export interface TransactionalEmailProvider {
  describe(): AdapterDescriptor<{ transactional: boolean }>;
  send(message: TransactionalEmail): Promise<void>;
  /** Wait for accepted in-flight deliveries before a graceful shutdown completes. */
  drain?(): Promise<void>;
}

/**
 * Seat-based subscription billing. Product code owns access rules; adapters own the
 * vendor API. Sync is pull-based: webhooks only say which customer changed.
 */
export interface BillingProvider {
  /** Optional prepaid model usage capabilities; product code owns the balance ledger. */
  createCreditCheckout?(input: BillingCreditCheckoutRequest): Promise<{ url: string }>;
  listCreditPurchases?(customerId: string): Promise<BillingCreditPurchase[]>;
  setMonthlyCredits?(customerId: string, amountCents: number): Promise<void>;
  /** Flat monthly own-key plan: access without credits. */
  createByokCheckout?(input: BillingByokCheckoutRequest): Promise<{ url: string }>;
  /** Ends the customer's running trial now and bills the first period; a no-op without one. */
  endTrial?(customerId: string): Promise<void>;
  /**
   * Moves the customer's own-key subscription `subscriptionId` from plan `from` to plan `to`,
   * billing the prorated difference now: a change of interval restarts the period today, crediting
   * its unused part. A failed payment leaves the plan unchanged. Returns false without charging
   * when that subscription is no longer an active or trialing `from` plan, is set to cancel, or
   * monthly credits have started.
   */
  changeByokPlan?(
    customerId: string,
    subscriptionId: string,
    change: { from: BillingByokPlan; to: BillingByokPlan },
  ): Promise<boolean>;
  /** Ends every live own-key plan at its period end. */
  endByokPlans?(customerId: string): Promise<void>;
  /**
   * Credits the customer's account; future invoices draw it down before charging. Idempotent per
   * `referenceId`, so a retry after an unknown outcome never credits twice.
   */
  grantBalanceCredit?(customerId: string, amountCents: number, referenceId: string): Promise<void>;
  describe(): AdapterDescriptor<{ trials: boolean; portal: boolean; modelCredits?: boolean }>;
  getPrice(): Promise<BillingPrice>;
  createCustomer(input: { email: string; organizationId: string }): Promise<{ customerId: string }>;
  createCheckout(input: BillingCheckoutRequest): Promise<{ url: string }>;
  /** Expires every open checkout session of the customer; resolves once none can be paid. */
  expireOpenCheckouts(customerId: string): Promise<void>;
  createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Current subscription for the customer, preferring one that grants access. */
  getCustomerSubscription(customerId: string): Promise<BillingSubscriptionSnapshot | null>;
  /** Sets seats on the customer's subscription; a no-op when none can still take updates. */
  updateSeats(customerId: string, seats: number): Promise<void>;
  cancelCustomerSubscriptions(customerId: string): Promise<void>;
  /** Verifies the signature. `null` means the request is not authentic. */
  parseWebhook(rawBody: string, headers: Headers): { customerId: string } | "ignored" | null;
}

export interface ExecutionRunner {
  describe(): AdapterDescriptor<{ cloud: boolean; selfHosted: boolean; desktop: boolean }>;
  dispatch(runId: string, target: "cloud" | "self-hosted" | "desktop"): Promise<void>;
}

export interface VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities>;
  verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult>;
  /** `options.language` narrows the listing for providers that advertise `languages`. */
  listVoices(
    apiKey: string,
    context: AdapterContext,
    options?: { language?: string },
  ): Promise<VoiceInfo[]>;
  synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip>;
  transcribe?(request: VoiceTranscribeRequest, context: AdapterContext): Promise<{ text: string }>;
}

/**
 * Deployment-wide external chat surface: one bot presence across messaging
 * platforms (iMessage/SMS, Slack, WhatsApp, …). Conversations are addressed
 * by opaque provider-prefixed thread ids ("sendblue:…", "slack:C1:…"), so
 * orchestration never sees platform wire formats. Webhook verification and
 * payload translation live behind handleWebhook, per platform.
 */
export interface MessagingSurface {
  describe(): AdapterDescriptor<{ providers: string[] }>;
  /** Enabled platforms and what each supports. */
  platforms(): MessagingPlatformDescriptor[];
  /**
   * Verify and process one platform webhook request. Parsed events reach the
   * sink registered via onInbound before the returned response resolves.
   * Returns null for a provider this surface does not host.
   */
  handleWebhook(provider: string, request: Request): Promise<Response> | null;
  /** Register the single downstream consumer of inbound events. */
  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>): void;
  sendToThread(
    request: MessagingSendRequest,
    context: AdapterContext,
  ): Promise<MessagingSendResult>;
  /** Resolve (or create) the 1:1 thread for a provider address. */
  openDirectThread(provider: string, address: string, context: AdapterContext): Promise<string>;
  /**
   * Best-effort receipt for inbound message `handle`. Never gates delivery;
   * no-ops on platforms without a receipt.
   */
  acknowledge(threadId: string, handle: string, context: AdapterContext): Promise<void>;
  /**
   * Up to `limit` messages posted in a thread before the `before` handle,
   * oldest first, normalized like inbound events. Absent when no platform can.
   */
  fetchThreadHistory?(
    threadId: string,
    options: { before: string; limit: number },
    context: AdapterContext,
  ): Promise<MessagingInboundMessage[]>;
  /**
   * Start eagerly. Adapters that pull updates themselves (Telegram polling when no public
   * webhook URL is reachable) otherwise never start until a webhook or send touches them.
   */
  initialize?(): Promise<void>;
  /**
   * Release long-lived inbound resources (Telegram getUpdates polling) so a
   * replacement process can claim them. No-op when the surface never started.
   */
  shutdown?(): Promise<void>;
}

/**
 * Provider-neutral web search. Builtin `web_search` routes here so backends
 * (keyless HTTP, model-native search, future paid APIs) can be swapped without
 * changing tool names or the executor.
 */
export interface WebSearchProvider {
  describe(): AdapterDescriptor<WebSearchCapabilities>;
  search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]>;
}

/**
 * Provider-neutral page fetch. Builtin `web_fetch` routes here. Read-only:
 * no JS execution, no headless browser.
 */
export interface WebFetchProvider {
  describe(): AdapterDescriptor<WebFetchCapabilities>;
  fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult>;
}

/** Convenience when one adapter owns both search and fetch. */
export interface WebProvider extends WebSearchProvider, WebFetchProvider {
  describe(): AdapterDescriptor<WebSearchCapabilities & WebFetchCapabilities>;
}

/**
 * Provider-neutral page browser on the bot computer, not a hosted browser product. Prefer it
 * for web pages; use computer_act when the page tool cannot operate or the task needs the desktop.
 */
export interface BrowserProvider {
  describe(): AdapterDescriptor<BrowserCapabilities>;
  navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult>;
  snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult>;
  act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult>;
  /**
   * Whether these clicks, or a click or key on the screen, would complete a purchase, without acting.
   * A browser that cannot tell, such as an older computer image, answers none.
   */
  purchaseCheck?(
    computer: ComputerRef,
    request: BrowserPurchaseCheckRequest,
    context: AdapterContext,
  ): Promise<BrowserPurchaseCheckResult>;
}

/**
 * Provider-neutral remote cloud coding agents (clone a repo on a vendor VM,
 * open a PR). Not the bot computer — shell/sandbox stays separate. Core runs
 * with none configured; tools are injected only when a provider is present.
 */
export interface CloudAgentProvider {
  describe(): AdapterDescriptor<CloudAgentCapabilities>;
  launch(request: CloudAgentLaunchRequest, context: AdapterContext): Promise<CloudAgentHandle>;
  get(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot>;
  reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle>;
  cancel(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot>;
}

/**
 * Provider-neutral "is this tool call safe to auto-allow?" check. Swap vendors
 * without changing approval UX (pass → run, ask → card).
 * Core runs with none configured and falls back to the LLM adapter.
 */
export interface AutoReviewProvider {
  describe(): AdapterDescriptor<AutoReviewCapabilities>;
  review(request: AutoReviewRequest, context: AdapterContext): Promise<AutoReviewResult>;
}
