import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryForgetRequest,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { HonchoConnectionConfig, HonchoReasoningLevel } from "./honcho-client.js";
import {
  createHonchoConclusions,
  deleteHonchoConclusion,
  ensureHonchoPeers,
  ensureHonchoWorkspace,
  getHonchoConclusion,
  HONCHO_CLOUD_BASE_URL,
  HONCHO_REASONING_LEVELS,
  honchoPeerChat,
  honchoResourceId,
  isHonchoConclusionId,
  MAX_HONCHO_CONCLUSION_BYTES,
  probeHonchoAdminKey,
  queryHonchoConclusions,
} from "./honcho-client.js";
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

export const HONCHO_PROVIDER_ID = "honcho";

// Shared peers are workspace-scoped; only an explicit workspace opts Spaces into sharing.
const SHARED_PEER_ID = honchoResourceId("rakazo-shared");

const DEFAULT_REASONING_LEVEL: HonchoReasoningLevel = "low";

/** Sentinel the dialectic is asked to return when it has nothing relevant. */
const NO_MEMORY = "NO_RELEVANT_MEMORY";

/** Honcho returns at most this many conclusions per search. */
const MAX_COPIES_PER_SEARCH = 100;
/** Includes the cited fact; leave it available for retry when cleanup reaches the cap. */
const MAX_DELETIONS_PER_FORGET = 200;

/**
 * Local mode reaches the server network, so the operator must authorize private endpoints.
 * Fails closed: any mode other than an absent one or "cloud" needs the owner.
 */
export function honchoRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  return settings.mode !== undefined && settings.mode !== "cloud";
}

/** Spaces do not share memory implicitly, so each Space gets its own Honcho workspace by default. */
export function honchoWorkspaceId(settings: Record<string, string>, spaceId: string): string {
  const configured = settings.workspaceId?.trim();
  return honchoResourceId(configured || `rakazo-${spaceId}`);
}

export function honchoBotPeerId(botId: string): string {
  return honchoResourceId(`bot-${botId}`);
}

/** Peer IDs Rakazo creates and writes to: the shared Space peer and every bot peer. */
export function isReservedHonchoPeerId(peerId: string): boolean {
  return peerId === SHARED_PEER_ID || peerId.startsWith("bot-");
}

function parseHonchoConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): { connection: HonchoConnectionConfig; workspaceId: string; userPeerId: string; local: boolean } {
  // Configurations saved before local mode carry no mode and always meant Honcho Cloud.
  // Match exactly, as honchoRequiresPrivateEndpoint does, so the owner gate sees the same mode.
  const mode = settings.mode ?? "cloud";
  if (mode !== "cloud" && mode !== "local") throw new Error("mode must be cloud or local");
  const local = mode === "local";
  const baseUrl = local ? settings.baseUrl?.trim() : HONCHO_CLOUD_BASE_URL;
  if (!baseUrl) throw new Error("baseUrl is required");
  if (local) {
    // The cloud origin takes the unpinned cloud transport, so it cannot be a local endpoint.
    if (parseServiceBaseUrl(baseUrl).origin === HONCHO_CLOUD_BASE_URL) {
      throw new Error("Local mode cannot use the Honcho Cloud URL.");
    }
    assertLocalServiceBaseUrlSync(baseUrl);
  }
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey || apiKey.length < 8 || apiKey.length > 4096) {
    throw new Error("apiKey must contain 8–4096 characters");
  }
  const reasoningLevel = (settings.reasoningLevel?.trim() ||
    DEFAULT_REASONING_LEVEL) as HonchoReasoningLevel;
  if (!HONCHO_REASONING_LEVELS.includes(reasoningLevel)) {
    throw new Error(`reasoningLevel must be one of ${HONCHO_REASONING_LEVELS.join(", ")}`);
  }
  const workspaceId = settings.workspaceId?.trim() ?? "";
  if (workspaceId && !/^[A-Za-z0-9_-]{1,512}$/.test(workspaceId)) {
    throw new Error("workspaceId may contain only letters, digits, '_' and '-'");
  }
  const userPeerId = settings.userPeerId?.trim() ?? "";
  if (userPeerId && !/^[A-Za-z0-9_-]{1,512}$/.test(userPeerId)) {
    throw new Error("userPeerId may contain only letters, digits, '_' and '-'");
  }
  // Rakazo writes to its own peers, so a user peer that aliases one would not stay read-only.
  if (userPeerId && isReservedHonchoPeerId(userPeerId)) {
    throw new Error("userPeerId uses a peer ID reserved for Rakazo");
  }
  // A user peer only exists in a workspace another Honcho app already writes to.
  if (userPeerId && !workspaceId) {
    throw new Error("userPeerId requires the workspace that holds that peer");
  }
  return {
    connection: { baseUrl, apiKey, reasoningLevel },
    workspaceId,
    userPeerId,
    local,
  };
}

export async function prepareHonchoConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    fetch?: typeof globalThis.fetch;
  },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const { connection, workspaceId, userPeerId, local } = parseHonchoConnection(
    settings,
    credentials,
  );
  // Loopback needs no DNS pin, so refuse non-owners here before any request is sent.
  if (local && options?.allowPrivateEndpoint !== true) {
    throw egressRefused(
      URL.parse(connection.baseUrl)?.hostname ?? "",
      new MemoryProviderPrivateEndpointRequiredError(),
    );
  }
  const pinnedAddresses = local
    ? await pinLocalServiceHost(connection.baseUrl, options)
    : undefined;
  const probeConnection: HonchoConnectionConfig = {
    ...connection,
    fetch: options?.fetch,
    resolveHostname: options?.resolveHostname,
    ...(pinnedAddresses ? { pinnedAddresses } : {}),
  };
  // An explicit workspace must accept this key. Without one, each Space creates its own
  // workspace on first use, which only an admin key may do; listing checks that without writing.
  const probe = workspaceId
    ? await ensureHonchoWorkspace(probeConnection, workspaceId)
    : await probeHonchoAdminKey(probeConnection);
  if (!probe.ok) {
    throw new Error(
      workspaceId
        ? probe.error
        : `${probe.error}. A key scoped to one workspace needs that workspace entered.`,
    );
  }
  return {
    settings: {
      ...(local ? { mode: "local", baseUrl: connection.baseUrl } : {}),
      reasoningLevel: connection.reasoningLevel,
      ...(workspaceId ? { workspaceId } : {}),
      ...(userPeerId ? { userPeerId } : {}),
    },
    credentials: { apiKey: connection.apiKey },
  };
}

export function createHonchoProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  const { connection } = parseHonchoConnection(settings, credentials);
  return new HonchoMemoryProvider(connection, settings);
}

/**
 * Every fact is about the shared peer. Isolated: this bot's private view of it, independent of
 * the user. Shared: also the workspace-wide view that all opted-in Spaces write to.
 */
function recallObservers(scope: DurableMemoryScope, botId: string): string[] {
  const bot = honchoBotPeerId(botId);
  return scope === "shared" ? [SHARED_PEER_ID, bot] : [bot];
}

function normalizeMemory(memory: string): string {
  return memory.replace(/\s+/g, " ").trim().toLowerCase();
}

function recallQuery(query: string, subject = "this Space"): string {
  return [
    `Recall what you know about ${subject} that is relevant to the request below.`,
    "Answer with the relevant facts only, as short plain statements.",
    `If you know nothing relevant, answer exactly ${NO_MEMORY}.`,
    "",
    `Request: ${query}`,
  ].join("\n");
}

export class HonchoMemoryProvider implements SemanticMemoryProvider {
  private readonly ensured = new Map<string, Promise<boolean>>();
  private readonly localHost?: LocalServiceHost;

  constructor(
    private readonly connection: HonchoConnectionConfig,
    private readonly settings: Record<string, string>,
  ) {
    if (settings.mode === "local") {
      this.localHost = new LocalServiceHost(connection.baseUrl, connection.resolveHostname);
    }
  }

  /** Local hosts are checked and pinned before the first request, then reused. */
  private async connectionForRequest(): Promise<SemanticMemoryResponse<HonchoConnectionConfig>> {
    if (!this.localHost) return { ok: true, value: this.connection };
    const blocked = await this.localHost.block();
    if (blocked) return { ok: false, error: blocked };
    return { ok: true, value: this.localHost.withPin(this.connection) };
  }

  describe() {
    return {
      id: HONCHO_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
      } as const,
    };
  }

  /** Peers are get-or-create; remember success per provider so each run pays for it once. */
  private async ensurePeers(
    connection: HonchoConnectionConfig,
    workspaceId: string,
    peerIds: string[],
    signal: AbortSignal,
  ): Promise<SemanticMemoryResponse> {
    const key = [workspaceId, ...peerIds].join("\n");
    let pending = this.ensured.get(key);
    let error = "";
    if (!pending) {
      pending = ensureHonchoPeers(connection, workspaceId, peerIds, signal).then((result) => {
        if (!result.ok) error = result.error;
        return result.ok;
      });
      this.ensured.set(key, pending);
    }
    if (await pending) return { ok: true, value: undefined };
    this.ensured.delete(key);
    return { ok: false, error: error || "Honcho peers could not be created." };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    const workspaceId = honchoWorkspaceId(this.settings, context.spaceId);
    const bot = honchoBotPeerId(request.botId);
    const ready = await this.ensurePeers(
      connection.value,
      workspaceId,
      [SHARED_PEER_ID, bot],
      context.signal,
    );
    if (!ready.ok) return ready;
    const query = recallQuery(request.query);
    const observers = recallObservers(request.scope, request.botId);
    const perspectives: { peerId: string; target?: string; entity: string; query: string }[] =
      observers.map((entity) => ({
        peerId: entity,
        ...(entity === SHARED_PEER_ID ? {} : { target: SHARED_PEER_ID }),
        entity,
        query,
      }));
    // An existing user peer is read through Honcho's own representation and never written to.
    const userPeerId = this.settings.userPeerId?.trim();
    if (userPeerId) {
      perspectives.push({
        peerId: userPeerId,
        entity: userPeerId,
        query: recallQuery(request.query, "the user"),
      });
    }
    const answers = await Promise.all(
      perspectives.map(async ({ entity, ...perspective }) => {
        const [result, conclusions] = await Promise.all([
          honchoPeerChat(connection.value, workspaceId, perspective, context.signal),
          // Only Rakazo's own facts are cited, so forget never reaches the user peer.
          observers.includes(entity)
            ? queryHonchoConclusions(
                connection.value,
                workspaceId,
                {
                  query: request.query,
                  observerId: entity,
                  observedId: SHARED_PEER_ID,
                  topK: request.limit,
                },
                context.signal,
              )
            : undefined,
        ]);
        return { entity, result, conclusions };
      }),
    );
    const failures = answers.filter((answer) => !answer.result.ok);
    if (failures.length === answers.length) {
      return {
        ok: false,
        error: failures.map((answer) => (answer.result.ok ? "" : answer.result.error)).join("; "),
      };
    }
    const relevant = answers.filter(
      ({ result }) => result.ok && result.value && !result.value.includes(NO_MEMORY),
    );
    // Stored conclusions give forget_memory real ids. They follow only a relevant answer,
    // so the dialectic still decides whether a turn recalls anything.
    const seen = new Set<string>();
    const citedBy = relevant.map(({ entity, conclusions }) => {
      const cited: SemanticMemoryResult[] = [];
      for (const conclusion of conclusions?.ok ? conclusions.value : []) {
        const normalized = normalizeMemory(conclusion.content);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        cited.push({
          memory: conclusion.content,
          score: 1,
          id: conclusion.id,
          provenance: "honcho",
          entity,
        });
      }
      return cited;
    });
    // Perspectives take turns so one cannot crowd another's ids out of the limit.
    const cited: SemanticMemoryResult[] = [];
    for (let round = 0; citedBy.some((list) => round < list.length); round++) {
      for (const list of citedBy) {
        const result = list[round];
        if (result) cited.push(result);
      }
    }
    // An answer that repeats a cited fact verbatim adds nothing the citation lacks.
    const results: SemanticMemoryResult[] = [];
    for (const { entity, result } of relevant) {
      if (!result.ok) continue;
      const normalized = normalizeMemory(result.value);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      results.push({ memory: result.value, score: 1, provenance: "honcho", entity });
    }
    return { ok: true, value: [...results, ...cited].slice(0, request.limit) };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    if (request.source.kind === "history") {
      // Compaction summaries stay in Rakazo; Honcho holds durable facts only.
      return { ok: true, value: undefined };
    }
    const content = truncateUtf8(request.content.trim(), MAX_HONCHO_CONCLUSION_BYTES);
    if (!content) return { ok: false, error: "Honcho save skipped: memory content is empty." };
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    const workspaceId = honchoWorkspaceId(this.settings, context.spaceId);
    const bot = honchoBotPeerId(request.botId);
    const ready = await this.ensurePeers(
      connection.value,
      workspaceId,
      [SHARED_PEER_ID, bot],
      context.signal,
    );
    if (!ready.ok) return ready;
    const conclusions = [{ content, observerId: bot, observedId: SHARED_PEER_ID }];
    if (request.scope === "shared")
      conclusions.push({ content, observerId: SHARED_PEER_ID, observedId: SHARED_PEER_ID });
    return createHonchoConclusions(connection.value, workspaceId, conclusions, context.signal);
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    const id = request.id.trim();
    if (!id) return { ok: false, error: "id is required" };
    if (!isHonchoConclusionId(id)) return { ok: false, error: "Invalid Honcho conclusion id." };
    const observers = recallObservers(request.scope, request.botId);
    if (request.entity && !observers.includes(request.entity)) {
      return { ok: false, error: "That memory belongs to another bot or Space." };
    }
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    const workspaceId = honchoWorkspaceId(this.settings, context.spaceId);
    const found = await getHonchoConclusion(connection.value, workspaceId, id, context.signal);
    if (!found.ok) return found;
    // Honcho deletes any conclusion in the workspace, so only facts this bot can recall qualify.
    const recallable = (conclusion: { observerId: string; observedId: string }) =>
      conclusion.observedId === SHARED_PEER_ID && observers.includes(conclusion.observerId);
    const fact = found.value;
    if (
      !fact ||
      fact.id !== id ||
      !recallable(fact) ||
      (request.entity && fact.observerId !== request.entity)
    ) {
      return { ok: false, error: "No memory with that id was found in this bot's memory." };
    }
    // A shared save writes the fact from two perspectives, repeated saves add more copies, and
    // recall cites only one. Remove every copy this bot could recall again: deleted copies leave
    // the search, so search again until none remain or the deletion cap is reached. The cited
    // fact goes last, so a failed forget can be retried with the same id.
    const key = normalizeMemory(fact.content);
    const deleted = new Set([fact.id]);
    for (;;) {
      const copies = await Promise.all(
        observers.map((observerId) =>
          queryHonchoConclusions(
            connection.value,
            workspaceId,
            {
              query: fact.content,
              observerId,
              observedId: SHARED_PEER_ID,
              topK: MAX_COPIES_PER_SEARCH,
            },
            context.signal,
          ),
        ),
      );
      const pending = new Set<string>();
      for (const copy of copies) {
        if (!copy.ok) return copy;
        for (const conclusion of copy.value) {
          if (
            !deleted.has(conclusion.id) &&
            recallable(conclusion) &&
            normalizeMemory(conclusion.content) === key
          ) {
            pending.add(conclusion.id);
          }
        }
      }
      if (pending.size === 0) break;
      const batch = [...pending].slice(0, MAX_DELETIONS_PER_FORGET - deleted.size);
      const results = await Promise.all(
        batch.map((conclusionId) =>
          deleteHonchoConclusion(connection.value, workspaceId, conclusionId, context.signal),
        ),
      );
      const failure = results.find((result) => !result.ok);
      if (failure) return failure;
      for (const conclusionId of batch) deleted.add(conclusionId);
      if (batch.length < pending.size) {
        return { ok: false, error: "Honcho forget reached its deletion limit. Retry this id." };
      }
    }
    const removed = await deleteHonchoConclusion(
      connection.value,
      workspaceId,
      fact.id,
      context.signal,
    );
    if (!removed.ok) return removed;
    return { ok: true, value: { id: fact.id, expired: true, reason: request.reason ?? null } };
  }

  async purgeHistory(
    _request: { botId: string; generations: number[] },
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // History generations are never written to Honcho.
    return { ok: true, value: undefined };
  }
}
