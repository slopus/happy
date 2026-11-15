import type {
  AdapterContext,
  ConnectorCall,
  ManagedConnectorProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { IntegrationProviderConfig, IntegrationProviderId } from "@rakazo/contracts";
import { IntegrationProviderConfigSchema, IntegrationProviderIdSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { ComposioConnector } from "./composio-connector.js";
import { credentialDigest } from "./credential-digest.js";
import { PipedreamConnector } from "./pipedream-connector.js";

const PLUGIN_SLUG_PROVIDER: IntegrationProviderId = "composio";

/** Resolve persisted credentials on every operation so API and workers observe changes.
 * Cache adapters by ciphertext to preserve sessions without retaining old credentials. */
export class IntegrationProviderSettings {
  private readonly cache = new Map<
    string,
    { ciphertext: string; digest: string; adapter: ManagedConnectorProvider }
  >();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly identitySecret: string,
    private readonly fallbacks: Partial<
      Record<IntegrationProviderId, ManagedConnectorProvider>
    > = {},
    private readonly factory?: (config: IntegrationProviderConfig) => ManagedConnectorProvider,
  ) {
    this.secrets.onChange?.((ref) => {
      for (const [id, entry] of this.cache) if (entry.ciphertext === ref) this.cache.delete(id);
    });
  }

  private create(config: IntegrationProviderConfig): ManagedConnectorProvider {
    if (this.factory) return this.factory(config);
    return config.provider === "composio"
      ? new ComposioConnector({ apiKey: config.apiKey })
      : new PipedreamConnector({ ...config, identitySecret: this.identitySecret });
  }

  async configured(id: IntegrationProviderId): Promise<boolean> {
    return (
      Boolean(
        await this.prisma.integrationProviderConfig.findUnique({
          where: { id },
          select: { id: true },
        }),
      ) || Boolean(this.fallbacks[id])
    );
  }

  async resolve(id: IntegrationProviderId): Promise<ManagedConnectorProvider | undefined> {
    return (await this.prepare(id)).provider;
  }

  async prepare(
    id: IntegrationProviderId,
  ): Promise<{ provider: ManagedConnectorProvider | undefined; ref: string | null }> {
    const row = await this.prisma.integrationProviderConfig.findUnique({ where: { id } });
    if (!row) {
      this.cache.delete(id);
      return { provider: this.fallbacks[id], ref: null };
    }
    let invalidated = false;
    const unsubscribe =
      this.secrets.onChange?.((ref) => {
        if (ref === row.ciphertext) invalidated = true;
      }) ?? (() => {});
    try {
      const plaintext = await this.secrets.load(row.ciphertext, `integration-provider:${id}`);
      if (invalidated) return await this.prepare(id);
      const cached = this.cache.get(id);
      const digest = credentialDigest(plaintext);
      if (cached?.ciphertext === row.ciphertext && cached.digest === digest)
        return { provider: cached.adapter, ref: row.ciphertext };
      const config = IntegrationProviderConfigSchema.parse(JSON.parse(plaintext));
      if (config.provider !== id)
        throw new Error("Integration provider configuration does not match");
      const adapter = this.create(config);
      this.cache.set(id, { ciphertext: row.ciphertext, digest, adapter });
      return { provider: adapter, ref: row.ciphertext };
    } finally {
      unsubscribe();
    }
  }

  async save(config: IntegrationProviderConfig, context: AdapterContext): Promise<void> {
    const adapter = this.create(config);
    try {
      // Exercises authenticated access before replacing working credentials.
      await adapter.listConnectedExternalIds(context);
    } catch {
      // Provider errors can contain credentials or account details.
      throw new Error("Could not verify these credentials");
    }
    const stored = await this.secrets.put(JSON.stringify(config), context, {
      recordId: `integration-provider:${config.provider}`,
    });
    await this.prisma.integrationProviderConfig.upsert({
      where: { id: config.provider },
      create: { id: config.provider, ciphertext: stored.ciphertext },
      update: { ciphertext: stored.ciphertext },
    });
    // The store may have expired or invalidated this ref while persistence waited.
    // Re-resolve through it before retaining any provider credentials.
    this.cache.delete(config.provider);
  }

  /** Connected app slugs from the provider whose app ids match plugin slugs. */
  async listConnectedPluginSlugs(userId: string): Promise<string[]> {
    const provider = await this.resolve(PLUGIN_SLUG_PROVIDER);
    if (!provider) return [];
    return provider.listConnectedExternalIds({
      userId,
      spaceId: "",
      operationId: "connections.sync",
      traceId: "connections.sync",
      signal: AbortSignal.timeout(15_000),
    });
  }

  providers(): ManagedConnectorProvider[] {
    return IntegrationProviderIdSchema.options.map(
      (id) => new ConfiguredIntegrationProvider(id, this),
    );
  }

  /** Warm catalogs for env- and DB-configured providers. Fire-and-forget. */
  warmDirectories(): void {
    for (const id of IntegrationProviderIdSchema.options) {
      void this.resolve(id)
        .then((provider) => provider?.warmDirectory?.())
        .catch(() => undefined);
    }
  }
}

class ConfiguredIntegrationProvider implements ManagedConnectorProvider {
  readonly resolveConnectedAccountId?: ManagedConnectorProvider["resolveConnectedAccountId"];
  readonly cancelAuthorizationRequest?: ManagedConnectorProvider["cancelAuthorizationRequest"];
  readonly revokeUnreferencedAccounts?: ManagedConnectorProvider["revokeUnreferencedAccounts"];

  constructor(
    private readonly id: IntegrationProviderId,
    private readonly settings: IntegrationProviderSettings,
    private readonly prepared?: ManagedConnectorProvider,
  ) {
    // Only a prepared provider is known up front; callers branch on which of these exist.
    this.resolveConnectedAccountId = prepared?.resolveConnectedAccountId?.bind(prepared);
    this.cancelAuthorizationRequest = prepared?.cancelAuthorizationRequest?.bind(prepared);
    this.revokeUnreferencedAccounts = prepared?.revokeUnreferencedAccounts?.bind(prepared);
  }
  async prepareForTransaction() {
    const prepared = await this.settings.prepare(this.id);
    return {
      provider: prepared.provider
        ? new ConfiguredIntegrationProvider(this.id, this.settings, prepared.provider)
        : undefined,
      recheck: async (client: Pick<PrismaClient, "integrationProviderConfig">) => {
        const current = await client.integrationProviderConfig.findUnique({
          where: { id: this.id },
          select: { ciphertext: true },
        });
        return (current?.ciphertext ?? null) === prepared.ref;
      },
    };
  }
  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }
  private async resolve() {
    return this.prepared ?? this.settings.resolve(this.id);
  }
  private async required() {
    const provider = await this.resolve();
    if (!provider) throw new Error("Set up an integration provider in Integrations first");
    return provider;
  }
  async catalog(context: AdapterContext, query?: string) {
    return (await this.resolve())?.catalog(context, query) ?? [];
  }
  async listAppTools(context: AdapterContext, externalId: string) {
    const provider = await this.resolve();
    if (!provider) return [];
    return provider.listAppTools
      ? provider.listAppTools(context, externalId)
      : provider.discoverTools(context);
  }
  async discoverTools(context: AdapterContext) {
    return (await this.resolve())?.discoverTools(context) ?? [];
  }
  async listConnectedExternalIds(context: AdapterContext) {
    return (await this.resolve())?.listConnectedExternalIds(context) ?? [];
  }
  async needsReconnect(context: AdapterContext, externalId: string) {
    return (await (await this.resolve())?.needsReconnect?.(context, externalId)) ?? false;
  }
  async listReconnectRefs(context: AdapterContext) {
    return (await (await this.resolve())?.listReconnectRefs?.(context)) ?? [];
  }
  async connectionReady(context: AdapterContext, externalId: string) {
    return (await this.required()).connectionReady(context, externalId);
  }
  async begin(request: Parameters<ManagedConnectorProvider["begin"]>[0], context: AdapterContext) {
    return (await this.required()).begin(request, context);
  }
  async complete(
    request: Parameters<ManagedConnectorProvider["complete"]>[0],
    context: AdapterContext,
  ) {
    return (await this.required()).complete(request, context);
  }
  async revoke(ref: string, context: AdapterContext) {
    return (await this.required()).revoke(ref, context);
  }
  async resolveCall(call: ConnectorCall, context: AdapterContext) {
    const provider = await (call.route ? this.required() : this.resolve());
    return provider?.resolveCall?.(call, context);
  }
  async *execute(call: ConnectorCall, context: AdapterContext) {
    yield* (await this.required()).execute(call, context);
  }
}

export async function prepareManagedConnectorForTransaction(connector: ManagedConnectorProvider) {
  return connector instanceof ConfiguredIntegrationProvider
    ? connector.prepareForTransaction()
    : { provider: connector, recheck: undefined };
}
