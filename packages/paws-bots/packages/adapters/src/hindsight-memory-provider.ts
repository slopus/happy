import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryConversationRequest,
  SemanticMemoryProvider,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryReflectRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { HindsightConnectionConfig } from "./hindsight-client.js";
import {
  deleteHindsightDocument,
  HINDSIGHT_CLOUD_BASE_URL,
  HINDSIGHT_CONNECTION_TIMEOUT_MS,
  HINDSIGHT_PURGE_TIMEOUT_MS,
  HINDSIGHT_RECALL_TIMEOUT_MS,
  HINDSIGHT_STATUS_TIMEOUT_MS,
  HINDSIGHT_WRITE_TIMEOUT_MS,
  hindsightBankExists,
  hindsightOperationStatus,
  listHindsightDocumentIdsByTag,
  probeHindsightKey,
  recallHindsight,
  reflectHindsight,
  retainHindsight,
} from "./hindsight-client.js";
import {
  assertLocalServiceBaseUrlSync,
  LocalServiceHost,
  parseServiceBaseUrl,
  pinLocalServiceHost,
} from "./local-service-endpoint.js";
import type { ResolveHostname } from "./network-address.js";
import { egressRefused } from "./network-address.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";
import { truncateUtf8 } from "./utf8.js";

export const HINDSIGHT_PROVIDER_ID = "hindsight";

const MAX_CONTENT_BYTES = 32_768;
/** Longest recall query sent. */
const MAX_QUERY_CHARS = 800;
/** Most tokens of recalled memory asked for. */
const RECALL_MAX_TOKENS = 4_096;
const MAX_RECALL_BANKS = 10;
const RECALL_BANK = /^[^\s/?#%\\,]{1,256}$/;
// Space IDs include legacy identifiers, so the whole generated namespace is reserved.
const RESERVED_BANK = /^rakazo-/i;
/** A failing extra bank is skipped this long; used only for recall. */
const EXTRA_BANK_COOLDOWN_MS = 5 * 60_000;
/** An extra bank still silent after this much of the recall timeout counts as failing. */
const EXTRA_BANK_RECALL_TIMEOUT_MS = HINDSIGHT_RECALL_TIMEOUT_MS * 0.8;
/** Purge deletes a conversation's per-turn documents a listed page at a time, at most this many pages. */
const MAX_PURGE_PAGES = 1_000;
const PURGE_BATCH_SIZE = 10;
const RECALL_BUDGETS = ["low", "mid", "high"];
const DEFAULT_RECALL_BUDGET = "mid";
/** With skipUnrelated, the server drops results its reranker scores below this. */
const MIN_RERANKER_SCORE = 0.25;

// Best-effort local hints, not cross-instance coordination: other instances may retry the bank.
// They never suppress writes or cleanup and carry no authorization state.
/** When each failing extra bank may be asked again. Kept after expiry until it answers. */
const bankCooldowns = new Map<string, number>();
/** Banks that refused an append but stored the turn as its own document. */
const banksWithoutAppend = new Set<string>();

function bankKey(connection: string, bank: string): string {
  return `${connection}\n${bank}`;
}

function coolingDown(connection: string, bank: string): boolean {
  return (bankCooldowns.get(bankKey(connection, bank)) ?? 0) > Date.now();
}

/** Starts a cooldown for a failing extra bank, or ends one for an answering bank. */
function noteExtraBank(connection: string, bank: string, answered: boolean): void {
  const key = bankKey(connection, bank);
  const wasDown = bankCooldowns.has(key);
  if (answered) {
    if (!wasDown) return;
    bankCooldowns.delete(key);
    getLogger().info("Hindsight bank is answering again", { bank });
    return;
  }
  bankCooldowns.set(key, Date.now() + EXTRA_BANK_COOLDOWN_MS);
  if (!wasDown) {
    getLogger().warn("Hindsight bank is not answering; skipping it for five minutes", { bank });
  }
}

/** Test-only: forgets every bank's cooldown and append refusal. */
export function resetHindsightBankState(): void {
  bankCooldowns.clear();
  banksWithoutAppend.clear();
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function conversationContext(request: SemanticMemoryConversationRequest): string {
  const speakers = [
    ...new Set(request.turns.flatMap((turn) => (turn.speaker ? [turn.speaker] : []))),
  ];
  if (request.conversation === "group") {
    return `Group chat in Rakazo with ${joinNames([...new Set([request.userName, request.botName, ...speakers])])}`;
  }
  if (speakers.length) {
    return `Conversation in Rakazo with ${joinNames([...new Set([request.userName, request.botName, ...speakers])])}`;
  }
  return `Chat in Rakazo between ${request.userName} and ${request.botName}, an AI assistant`;
}

/**
 * Local mode reaches the server network, so the operator must authorize private endpoints.
 * Fails closed: any mode other than an absent one or "cloud" needs the owner.
 */
export function hindsightRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  return settings.mode !== undefined && settings.mode !== "cloud";
}

interface HindsightOptions {
  /** Other apps' banks, recalled read-only after the bot's own. */
  recallBanks: string[];
  retainConversations: boolean;
  /** Off: the bot recalls only through its memory tools. */
  autoRecall: boolean;
  recallBudget: string;
  /** Recall world and experience facts as well as observations. */
  recallFacts: boolean;
  /** Asks the server to drop results the reranker scores under MIN_RERANKER_SCORE. */
  skipUnrelated: boolean;
}

function parseRecallBanks(value: string | undefined): string[] {
  const banks = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((bank) => bank.trim())
        .filter(Boolean),
    ),
  ];
  if (banks.some((bank) => !RECALL_BANK.test(bank))) {
    throw new Error("recallBanks may not contain spaces, /, ?, #, % or \\");
  }
  if (banks.some((bank) => bank === "." || bank === "..")) {
    throw new Error("recallBanks may not include . or ..");
  }
  // Rakazo's own banks are recalled automatically; another Space's must never be named.
  if (banks.some((bank) => RESERVED_BANK.test(bank))) {
    throw new Error("Bank names starting with rakazo- are reserved.");
  }
  if (banks.length > MAX_RECALL_BANKS) throw new Error("recallBanks may list at most 10 banks");
  return banks;
}

function parseHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): { connection: HindsightConnectionConfig; options: HindsightOptions; local: boolean } {
  const mode = settings.mode ?? "cloud";
  if (mode !== "cloud" && mode !== "local") throw new Error("mode must be cloud or local");
  const local = mode === "local";
  const baseUrl = local ? settings.baseUrl?.trim() : HINDSIGHT_CLOUD_BASE_URL;
  if (!baseUrl) throw new Error("baseUrl is required");
  if (local) {
    // The cloud origin takes the unpinned cloud transport, so it cannot be a local endpoint.
    if (parseServiceBaseUrl(baseUrl).origin === HINDSIGHT_CLOUD_BASE_URL) {
      throw new Error("Local mode cannot use the Hindsight Cloud URL.");
    }
    assertLocalServiceBaseUrlSync(baseUrl);
  }
  const apiKey = credentials.apiKey?.trim() ?? "";
  const keyFits = apiKey.length >= 8 && apiKey.length <= 4096;
  if (!local && !keyFits) throw new Error("apiKey must contain 8–4096 characters");
  // A self-hosted server runs without authentication by default.
  if (local && apiKey !== "" && !keyFits) {
    throw new Error("apiKey must be empty or contain 8–4096 characters");
  }
  const recallBudget = settings.recallBudget ?? DEFAULT_RECALL_BUDGET;
  if (!RECALL_BUDGETS.includes(recallBudget)) {
    throw new Error("recallBudget must be low, mid or high");
  }
  if (settings.recallFacts !== undefined && !["true", "false"].includes(settings.recallFacts)) {
    throw new Error("recallFacts must be true or false");
  }
  return {
    connection: { baseUrl, apiKey },
    options: {
      recallBanks: parseRecallBanks(settings.recallBanks),
      retainConversations: settings.retainConversations !== "false",
      autoRecall: settings.autoRecall !== "false",
      recallBudget,
      recallFacts: settings.recallFacts === "true",
      skipUnrelated: settings.skipUnrelated === "true",
    },
    local,
  };
}

export async function prepareHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    fetch?: typeof globalThis.fetch;
  },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const { connection, options: parsed, local } = parseHindsightConnection(settings, credentials);
  // Loopback needs no DNS pin, so refuse non-owners here before any request is sent.
  if (local && options?.allowPrivateEndpoint !== true) {
    throw egressRefused(
      URL.parse(connection.baseUrl)?.hostname ?? "",
      new MemoryProviderPrivateEndpointRequiredError(),
    );
  }
  const signal = AbortSignal.timeout(HINDSIGHT_CONNECTION_TIMEOUT_MS);
  const pinnedAddresses = local
    ? await pinLocalServiceHost(connection.baseUrl, { ...options, signal })
    : undefined;
  const probeConnection: HindsightConnectionConfig = {
    ...connection,
    fetch: options?.fetch,
    resolveHostname: options?.resolveHostname,
    ...(pinnedAddresses ? { pinnedAddresses } : {}),
  };
  const probe = await probeHindsightKey(probeConnection, signal);
  if (!probe.ok) throw new Error(probe.error);
  const { recallBanks, retainConversations, autoRecall, recallBudget, recallFacts, skipUnrelated } =
    parsed;
  // The bots' own banks are created on first write, but another app's must already be there.
  const checked = await Promise.all(
    recallBanks.map((bank) => hindsightBankExists(probeConnection, bank, signal)),
  );
  for (const [index, bank] of recallBanks.entries()) {
    const exists = checked[index]!;
    if (!exists.ok)
      throw new Error(`Hindsight bank "${bank}" could not be verified: ${exists.error}`);
    if (!exists.value) throw new Error(`Hindsight bank "${bank}" was not found.`);
  }
  return {
    settings: {
      ...(local ? { mode: "local", baseUrl: connection.baseUrl } : {}),
      ...(recallBanks.length ? { recallBanks: recallBanks.join(",") } : {}),
      ...(retainConversations ? {} : { retainConversations: "false" }),
      ...(autoRecall ? {} : { autoRecall: "false" }),
      ...(recallBudget === DEFAULT_RECALL_BUDGET ? {} : { recallBudget }),
      ...(recallFacts ? { recallFacts: "true" } : {}),
      ...(skipUnrelated ? { skipUnrelated: "true" } : {}),
    },
    credentials: { apiKey: connection.apiKey },
  };
}

export function createHindsightProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  connectionVersion?: string,
): SemanticMemoryProvider {
  const { connection, options } = parseHindsightConnection(settings, credentials);
  return new HindsightMemoryProvider(
    connection,
    options,
    settings.mode === "local",
    connectionVersion,
  );
}

/** Every bot keeps its own bank. */
function ownBank(spaceId: string, botId: string): string {
  return `${teamBank(spaceId)}-${createHash("sha256").update(botId).digest("hex")}`;
}

/** The Space's team bank, which bots that share memory also write to and recall from. */
function teamBank(spaceId: string): string {
  return `rakazo-${createHash("sha256").update(spaceId).digest("hex")}`;
}

function writeBanks(spaceId: string, botId: string, scope: DurableMemoryScope): string[] {
  const own = ownBank(spaceId, botId);
  return scope === "shared" ? [own, teamBank(spaceId)] : [own];
}

/** One appended document per conversation history. */
function sessionId(threadId: string, generation: number, botId: string): string {
  return `rakazo-${threadId}-${generation}-${botId}`;
}

/** A stable UUID v4-shaped digest, so a retried job reuses the same operation id. */
function operationUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  const variant = ((Number.parseInt(h.charAt(16), 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An operation a submitted turn waits on, in the bot's own bank or the Space's team bank. */
interface PendingOperation {
  bank: string;
  operationId: string;
  team?: true;
}

/** A submitted turn's operation id, or why the bank refused it. */
type StoredTurn = { ok: true; value: string } | { ok: false; error: string; status?: number };

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Undefined unless every entry names an operation in one of this Space's banks. */
function parsePendingOperations(pending: string, spaceId: string): PendingOperation[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(pending);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const team = teamBank(spaceId);
  const operations: PendingOperation[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return undefined;
    const { bank, operationId, team: isTeam } = entry as Record<string, unknown>;
    if (typeof bank !== "string" || typeof operationId !== "string") return undefined;
    if (!OPERATION_ID.test(operationId)) return undefined;
    if (isTeam === true ? bank !== team : isTeam !== undefined || !bank.startsWith(`${team}-`)) {
      return undefined;
    }
    operations.push({ bank, operationId, ...(isTeam === true ? { team: true as const } : {}) });
  }
  return operations;
}

/** Python counts code points; UTF-16 length is never smaller, so this stays under the limit. */
function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const end = /[\uD800-\uDBFF]/.test(value.charAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}

/**
 * Whether the operation stopped running; until then deleting the conversation's document finds
 * nothing to delete. Learning is best effort: an operation that failed, was cancelled or that the
 * server lost stored nothing, so it is done. A status check that fails says nothing, so it is not.
 */
async function operationDone(
  connection: HindsightConnectionConfig,
  bank: string,
  operationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const status = await hindsightOperationStatus(connection, bank, operationId, signal);
  if (!status.ok) {
    getLogger().warn("Hindsight operation status check failed", {
      bank,
      operationId,
      error: status.error,
    });
    return false;
  }
  if (status.value === "completed") return true;
  if (status.value === "failed" || status.value === "cancelled" || status.value === "not_found") {
    getLogger().warn("Hindsight did not store a conversation turn", {
      bank,
      operationId,
      status: status.value,
    });
    return true;
  }
  if (status.value !== "pending" && status.value !== "processing") {
    getLogger().warn("Hindsight reported an unknown operation status", {
      bank,
      operationId,
      status: status.value,
    });
  }
  return false;
}

export class HindsightMemoryProvider implements SemanticMemoryProvider {
  readonly connectionIdentity?: string;
  private readonly stateKey: string;
  private readonly localHost?: LocalServiceHost;
  readonly retainConversation?: (
    request: SemanticMemoryConversationRequest,
    context: AdapterContext,
  ) => Promise<SemanticMemoryResponse<{ pending?: string }>>;

  constructor(
    private readonly connection: HindsightConnectionConfig,
    private readonly options: HindsightOptions,
    local: boolean,
    connectionVersion?: string,
  ) {
    // Bind stored metadata to the effective endpoint, never to credential plaintext.
    this.connectionIdentity = connectionVersion
      ? createHash("sha256")
          .update(JSON.stringify([connectionVersion, connection.baseUrl]))
          .digest("hex")
      : undefined;
    // Standalone adapters have instance-local hints; persisted cleanup requires a stored identity.
    this.stateKey = this.connectionIdentity ?? randomUUID();
    if (local) {
      this.localHost = new LocalServiceHost(connection.baseUrl, connection.resolveHostname);
    }
    if (options.retainConversations) {
      this.retainConversation = (request, context) => this.retainTurn(request, context);
    }
  }

  /** Local hosts are checked and pinned before the first request, then reused. */
  private async connectionForRequest(
    signal?: AbortSignal,
  ): Promise<SemanticMemoryResponse<HindsightConnectionConfig>> {
    if (!this.localHost) return { ok: true, value: this.connection };
    const blocked = await this.localHost.block(signal);
    if (blocked) return { ok: false, error: blocked };
    return { ok: true, value: this.localHost.withPin(this.connection) };
  }

  describe() {
    return {
      id: HINDSIGHT_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        // Clearing a chat purges what was learned there even after learning is turned off.
        purgesByThread: true,
        sharedScope: true,
        ...(this.options.autoRecall
          ? { recallEachRun: true as const }
          : { recallOnRequestOnly: true as const }),
      } as const,
    };
  }

  /**
   * Recalls the bot's write banks, then the other apps' banks, all at once. The bot's own bank
   * failing fails an otherwise empty recall; successful banks still contribute. Rank all results together,
   * keeping the strongest duplicate and preferring the own bank on tied scores.
   */
  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const query = request.query.trim();
    if (!query) return { ok: true, value: [] };
    const signal = this.localHost
      ? AbortSignal.any([context.signal, AbortSignal.timeout(HINDSIGHT_RECALL_TIMEOUT_MS)])
      : context.signal;
    const connection = await this.connectionForRequest(signal);
    if (!connection.ok) return connection;
    const written = writeBanks(context.spaceId, request.botId, request.scope);
    const banks = [
      ...written,
      ...(request.includeExternal === false
        ? []
        : this.options.recallBanks.filter((bank) => !written.includes(bank))),
    ];
    const body = {
      query: truncateChars(query, MAX_QUERY_CHARS),
      budget: this.options.recallBudget,
      max_tokens: RECALL_MAX_TOKENS,
      types: this.options.recallFacts ? ["observation", "world", "experience"] : ["observation"],
      ...(this.options.skipUnrelated ? { min_scores: { reranker: MIN_RERANKER_SCORE } } : {}),
    };
    const stateKey = this.stateKey;
    const found = await Promise.all(
      banks.map(async (bank, index) => {
        // Own and shared Space memory use the full budget and are never cooled down.
        if (index < written.length) return recallHindsight(connection.value, bank, body, signal);
        if (coolingDown(stateKey, bank)) return undefined;
        const answer = await recallHindsight(
          connection.value,
          bank,
          body,
          signal,
          EXTRA_BANK_RECALL_TIMEOUT_MS,
        );
        if (!context.signal.aborted) noteExtraBank(stateKey, bank, answer.ok);
        return answer;
      }),
    );
    const results: SemanticMemoryResult[] = [];
    for (const [index, bank] of banks.entries()) {
      const answer = found[index];
      if (!answer) continue;
      if (!answer.ok) {
        if (index < written.length && !context.signal.aborted) {
          getLogger().warn("Hindsight recall failed for a Space memory bank", {
            bank,
            error: answer.error,
          });
        }
        continue;
      }
      const external = !written.includes(bank);
      for (const memory of answer.value) {
        results.push({
          memory: memory.text,
          score: memory.score,
          ...(memory.updatedAt ? { updatedAt: memory.updatedAt } : {}),
          ...(external ? { external: true as const } : {}),
          ...(external ? { provenance: "another app via hindsight" } : { provenance: "hindsight" }),
        });
      }
    }
    const own = found[0];
    if (!results.length && own && !own.ok) return own;
    // Stable sorting keeps the own bank first on ties. Rank before deduplication so a repeated
    // fact keeps its strongest match instead of its first bank's lower score.
    results.sort((left, right) => right.score - left.score);
    const seen = new Set<string>();
    const unique = results.filter((result) => {
      const text = result.memory.trim();
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
    return { ok: true, value: unique.slice(0, request.limit) };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // Compaction summaries are pre-summarized text, which Hindsight extracts poorly from.
    if (request.source.kind === "history") return { ok: true, value: undefined };
    const content = request.content.trim();
    if (!content) return { ok: false, error: "Hindsight save skipped: memory content is empty." };
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(HINDSIGHT_WRITE_TIMEOUT_MS),
    ]);
    const connection = await this.connectionForRequest(signal);
    if (!connection.ok) return connection;
    const item = {
      content: truncateUtf8(content, MAX_CONTENT_BYTES),
      context:
        "A fact a Rakazo AI assistant chose to remember about the people it works for and their work",
      timestamp: new Date().toISOString(),
    };
    // The same fact saved again by the same operation, as a retried tool call does, reuses its id,
    // so the server returns the stored operation instead of storing the fact twice.
    const fact = createHash("sha256").update(item.content).digest("hex");
    const [own, ...extra] = writeBanks(context.spaceId, request.botId, request.scope);
    // Synchronous: the fact is stored before the bot is told so, and a failure reaches the bot.
    const write = (bank: string) =>
      retainHindsight(
        connection.value,
        bank,
        {
          items: [item],
          async: false,
          operation_id: operationUuid(`rakazo-save:${bank}:${context.operationId}:${fact}`),
        },
        signal,
      );
    // Both writes reuse stable operation IDs, so a failed shared save can be retried safely.
    const first = await write(own!);
    if (!first.ok) return { ok: false, error: first.error };
    for (const bank of extra) {
      const written = await write(bank);
      if (!written.ok) return { ok: false, error: written.error };
    }
    return { ok: true, value: undefined };
  }

  /**
   * Appends the turn to its conversation's document in each write bank. `pending` lists the
   * operations to wait on; submitting again replays the same operations. A failing own bank
   * fails the call before the team bank is touched. Any failed bank fails the attempt so the
   * job can retry with the same operation IDs. Pre-submission recovery covers partial writes.
   */
  private async retainTurn(
    request: SemanticMemoryConversationRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ pending?: string }>> {
    const turns = request.turns.filter((turn) => turn.content.trim());
    const last = turns.at(-1);
    if (!last) return { ok: true, value: {} };
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(HINDSIGHT_WRITE_TIMEOUT_MS),
    ]);
    const connection = await this.connectionForRequest(signal);
    if (!connection.ok) return connection;
    const session = sessionId(request.threadId, request.generation, request.botId);
    const item = {
      content: JSON.stringify(
        turns.map((turn) => ({
          role: turn.role,
          content: `${turn.speaker ?? (turn.role === "user" ? "User" : "Assistant")}: ${truncateUtf8(turn.content, MAX_CONTENT_BYTES)}`,
          timestamp: turn.timestamp,
        })),
      ),
      context: conversationContext(request),
      timestamp: last.timestamp,
      tags: [`session:${session}`],
      observation_scopes: "shared",
    };
    const appended = { ...item, document_id: session, update_mode: "append" };
    // A bank keeping no document text stores each turn in its own document.
    const separate = { ...item, document_id: `rakazo-turn-${request.runId}` };
    const write = async (bank: string): Promise<StoredTurn> => {
      const key = bankKey(this.stateKey, bank);
      const store = async (stored: object, kind: string): Promise<StoredTurn> => {
        // One id per run and bank: a repeated call returns the original operation.
        const operationId = operationUuid(`${kind}:${request.runId}:${bank}`);
        const retained = await retainHindsight(
          connection.value,
          bank,
          { items: [stored], async: true, operation_id: operationId },
          signal,
        );
        return retained.ok ? { ok: true, value: operationId } : retained;
      };
      if (banksWithoutAppend.has(key)) return store(separate, "rakazo-turn-document");
      const stored = await store(appended, "rakazo-turn");
      // A bank keeping no document text refuses appends with a 400; the bank is remembered only
      // once the turn fits in its own document, so another bad request never sticks.
      if (stored.ok || stored.status !== 400) return stored;
      const separated = await store(separate, "rakazo-turn-document");
      if (separated.ok) banksWithoutAppend.add(key);
      return separated;
    };
    const [own, ...extra] = writeBanks(context.spaceId, request.botId, request.scope);
    const first = await write(own!);
    if (!first.ok) return { ok: false, error: first.error };
    const operations: PendingOperation[] = [{ bank: own!, operationId: first.value }];
    for (const bank of extra) {
      const written = await write(bank);
      if (!written.ok) return { ok: false, error: written.error };
      operations.push({ bank, operationId: written.value, team: true });
    }
    return { ok: true, value: { pending: JSON.stringify(operations) } };
  }

  /**
   * Checks each submitted operation once; settled once none is still running, so a purge after
   * that removes the turn. A status check that fails counts as still running: the job's check
   * limit bounds the wait.
   */
  async retainedConversationSettled(
    pending: string,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ settled: boolean }>> {
    const operations = parsePendingOperations(pending, context.spaceId);
    if (!operations) return { ok: false, error: "Hindsight got an invalid pending turn." };
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(HINDSIGHT_STATUS_TIMEOUT_MS),
    ]);
    const connection = await this.connectionForRequest(signal);
    if (!connection.ok) return connection;
    const settled = await Promise.all(
      operations.map(({ bank, operationId }) =>
        operationDone(connection.value, bank, operationId, signal),
      ),
    );
    return { ok: true, value: { settled: settled.every(Boolean) } };
  }

  /**
   * Bots may have written either bank, so both lose the cleared conversation: its appended
   * document and any per-turn documents tagged with it.
   */
  async purgeHistory(
    request: SemanticMemoryPurgeHistoryRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(HINDSIGHT_PURGE_TIMEOUT_MS),
    ]);
    const connection = await this.connectionForRequest(signal);
    if (!connection.ok) return connection;
    const banks = [ownBank(context.spaceId, request.botId), teamBank(context.spaceId)];
    const purge = async (bank: string, session: string): Promise<SemanticMemoryResponse> => {
      const deleted = await deleteHindsightDocument(connection.value, bank, session, signal);
      if (!deleted.ok) return deleted;
      // One listing more than pages deleted: the last one only checks that none remain.
      for (let page = 0; page <= MAX_PURGE_PAGES; page++) {
        const ids = await listHindsightDocumentIdsByTag(
          connection.value,
          bank,
          `session:${session}`,
          signal,
        );
        if (!ids.ok) return ids;
        if (!ids.value.length) return { ok: true, value: undefined };
        if (page === MAX_PURGE_PAGES) break;
        for (let offset = 0; offset < ids.value.length; offset += PURGE_BATCH_SIZE) {
          const removed = await Promise.all(
            ids.value
              .slice(offset, offset + PURGE_BATCH_SIZE)
              .map((id) => deleteHindsightDocument(connection.value, bank, id, signal)),
          );
          const failed = removed.find((result) => !result.ok);
          if (failed) return failed;
        }
      }
      return { ok: false, error: "Hindsight still lists documents of this conversation." };
    };
    const purged = await Promise.all(
      [...new Set(request.generations)].flatMap((generation) =>
        banks.map((bank) => purge(bank, sessionId(request.threadId, generation, request.botId))),
      ),
    );
    const errors = purged.flatMap((result) => (result.ok ? [] : [result.error]));
    return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true, value: undefined };
  }

  async reflect(
    request: SemanticMemoryReflectRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<string>> {
    const query = request.query.trim();
    if (!query) return { ok: true, value: "" };
    const connection = await this.connectionForRequest(context.signal);
    if (!connection.ok) return connection;
    return reflectHindsight(
      connection.value,
      ownBank(context.spaceId, request.botId),
      { query: truncateChars(query, MAX_QUERY_CHARS), budget: this.options.recallBudget },
      context.signal,
    );
  }
}
