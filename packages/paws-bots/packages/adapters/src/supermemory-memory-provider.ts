import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import {
  assertLocalServiceBaseUrlSync,
  LocalServiceHost,
  parseServiceBaseUrl,
  pinLocalServiceHost,
} from "./local-service-endpoint.js";
import type { ResolveHostname } from "./network-address.js";
import type { SupermemoryConnectionConfig } from "./supermemory-client.js";
import {
  deleteSupermemoryContainer,
  probeSupermemory,
  SUPERMEMORY_CLOUD_BASE_URL,
  saveSupermemoryMemoryToContainers,
  searchSupermemoryContainers,
} from "./supermemory-client.js";

export const SUPERMEMORY_PROVIDER_ID = "supermemory";
export { SUPERMEMORY_CLOUD_BASE_URL };

export function supermemoryRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  return settings.mode === "local";
}

function isSupermemoryCloudBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === new URL(SUPERMEMORY_CLOUD_BASE_URL).origin;
  } catch {
    return false;
  }
}

function requiredValue(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseSupermemoryConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SupermemoryConnectionConfig & { mode: "cloud" | "local" } {
  if (settings.mode !== "cloud" && settings.mode !== "local") {
    throw new Error("mode must be cloud or local");
  }
  const mode = settings.mode;
  const apiKey = requiredValue(credentials, "apiKey");
  if (apiKey.length < 8) throw new Error("apiKey must contain at least 8 characters");
  const baseUrl =
    mode === "cloud" ? SUPERMEMORY_CLOUD_BASE_URL : requiredValue(settings, "baseUrl");
  if (mode === "local") {
    // The cloud origin takes the unpinned cloud transport, so it cannot be a local endpoint.
    if (isSupermemoryCloudBaseUrl(baseUrl)) {
      throw new Error("Local mode cannot use the Supermemory Cloud URL.");
    }
    assertLocalServiceBaseUrlSync(baseUrl);
  }
  parseServiceBaseUrl(baseUrl);
  return { mode, baseUrl, apiKey };
}

export async function prepareSupermemoryConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    fetch?: typeof globalThis.fetch;
  },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const { mode, baseUrl, apiKey } = parseSupermemoryConnection(settings, credentials);
  const pinnedAddresses =
    mode === "local" ? await pinLocalServiceHost(baseUrl, options) : undefined;
  const connection: SupermemoryConnectionConfig = {
    baseUrl,
    apiKey,
    resolveHostname: options?.resolveHostname,
    fetch: options?.fetch,
    ...(pinnedAddresses ? { pinnedAddresses } : {}),
  };
  const probe = await probeSupermemory(connection);
  if (!probe.ok) throw new Error(probe.error);
  // Clearing a conversation deletes its memory, which only owner and admin keys may do.
  // Deleting a fresh random tag checks that without touching anyone's data.
  const deletable = await deleteSupermemoryContainer(
    `rakazo:delete-probe:${randomUUID()}`,
    connection,
  );
  if (!deletable.ok) throw new Error(deletable.error);
  return { settings: { mode, baseUrl }, credentials: { apiKey } };
}

export function createSupermemoryProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  const { baseUrl, apiKey } = parseSupermemoryConnection(settings, credentials);
  return new SupermemoryMemoryProvider({ baseUrl, apiKey });
}

export function decodeLegacySupermemoryCredentials(
  plaintext: string,
): Record<string, string> | null {
  return plaintext.trim() ? { apiKey: plaintext } : null;
}

function durableContainerTags(scope: DurableMemoryScope, botId: string, spaceId: string): string[] {
  const isolated = `rakazo:${botId}`;
  // This external namespace predates the Space rename. Keep it stable so
  // existing durable memories remain recallable; the identifier is a Space ID.
  return scope === "shared" ? [`rakazo:workspace:${spaceId}`, isolated] : [isolated];
}

function historyContainerTag(botId: string, generation: number): string {
  return `rakazo:${botId}:history:${generation}`;
}

function recallContainerTags(request: SemanticMemoryRecallRequest, spaceId: string): string[] {
  const tags = durableContainerTags(request.scope, request.botId, spaceId);
  return request.historyGeneration === undefined
    ? tags
    : [...tags, historyContainerTag(request.botId, request.historyGeneration)];
}

export class SupermemoryMemoryProvider implements SemanticMemoryProvider {
  private readonly localHost?: LocalServiceHost;

  constructor(private readonly connection: SupermemoryConnectionConfig) {
    if (!isSupermemoryCloudBaseUrl(connection.baseUrl)) {
      this.localHost = new LocalServiceHost(connection.baseUrl, connection.resolveHostname);
    }
  }

  private localBaseUrlBlock(): Promise<string | null> {
    return this.localHost?.block() ?? Promise.resolve(null);
  }

  private connectionForRequest(): SupermemoryConnectionConfig {
    return this.localHost?.withPin(this.connection) ?? this.connection;
  }

  describe() {
    return {
      id: SUPERMEMORY_PROVIDER_ID,
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

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    // Supermemory rejects an empty search query.
    if (!request.query.trim()) return { ok: true, value: [] };
    const blocked = await this.localBaseUrlBlock();
    if (blocked) return { ok: false, error: blocked };
    const result = await searchSupermemoryContainers(
      request.query,
      recallContainerTags(request, context.spaceId),
      this.connectionForRequest(),
      request.limit,
      context.signal,
    );
    return result.ok
      ? {
          ok: true,
          value: result.results.slice(0, request.limit).map((item) => ({
            memory: item.memory,
            score: item.similarity,
            ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
          })),
        }
      : result;
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const blocked = await this.localBaseUrlBlock();
    if (blocked) return { ok: false, error: blocked };
    const tags =
      request.source.kind === "history"
        ? [historyContainerTag(request.botId, request.source.generation)]
        : durableContainerTags(request.scope, request.botId, context.spaceId);
    const result = await saveSupermemoryMemoryToContainers(
      request.content,
      tags,
      this.connectionForRequest(),
      context.signal,
    );
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async purgeHistory(
    request: { botId: string; generations: number[] },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const blocked = await this.localBaseUrlBlock();
    if (blocked) return { ok: false, error: blocked };
    const results = await Promise.all(
      [...new Set(request.generations)].map((generation) =>
        deleteSupermemoryContainer(
          historyContainerTag(request.botId, generation),
          this.connectionForRequest(),
          context.signal,
        ),
      ),
    );
    const errors = results.filter((result) => !result.ok).map((result) => result.error);
    return errors.length > 0
      ? { ok: false, error: errors.join("; ") }
      : { ok: true, value: undefined };
  }

  static async probe(connection: SupermemoryConnectionConfig) {
    return probeSupermemory(connection);
  }
}
