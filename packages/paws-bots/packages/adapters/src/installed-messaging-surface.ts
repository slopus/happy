import type {
  AdapterContext,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingInstallation,
  MessagingInstallationStore,
  MessagingInstallProvider,
  MessagingSendRequest,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { MessagingSendError } from "./chat-sdk-surface.js";
import { credentialDigest } from "./credential-digest.js";

type CachedSurface = {
  workspaceId: string;
  digest: string;
  surface: MessagingSurface;
  users: number;
  retired: boolean;
};
const MAX_CACHED_SURFACES = 128;

/** Independent Chat SDK instances isolate workspace tokens, caches and dedupe state. */
export class InstalledMessagingSurface implements MessagingSurface {
  private readonly surfaces = new Map<string, CachedSurface>();
  private sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
  constructor(
    private readonly store: MessagingInstallationStore,
    private readonly provider: MessagingInstallProvider,
    private readonly fallback?: MessagingSurface,
  ) {}

  describe() {
    return {
      id: "installed-messaging",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { providers: this.platforms().map((p) => p.provider) },
    };
  }
  platforms() {
    return [
      ...(this.fallback?.platforms().filter((p) => p.provider !== this.provider.provider) ?? []),
      {
        provider: this.provider.provider,
        capabilities: this.provider.capabilities,
      },
    ];
  }
  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>) {
    this.sink = sink;
    this.fallback?.onInbound(sink);
  }
  initialize() {
    return this.fallback?.initialize?.() ?? Promise.resolve();
  }
  async shutdown() {
    const cached = [...this.surfaces.values()];
    this.surfaces.clear();
    await Promise.all(cached.map((entry) => this.retire(entry)));
    await this.fallback?.shutdown?.();
  }

  handleWebhook(provider: string, request: Request): Promise<Response> | null {
    if (provider !== this.provider.provider)
      return this.fallback?.handleWebhook(provider, request) ?? null;
    return this.webhook(request);
  }

  private async webhook(request: Request): Promise<Response> {
    let verified: Awaited<ReturnType<MessagingInstallProvider["parseWebhook"]>>;
    try {
      verified = await this.provider.parseWebhook(request);
    } catch {
      return new Response("Invalid webhook", { status: 401 });
    }
    if (verified.challenge !== undefined) return Response.json({ challenge: verified.challenge });
    if (!verified.workspaceId) return new Response("Missing workspace", { status: 400 });
    if (verified.uninstalled) {
      await this.store.removeWorkspace(this.provider.provider, verified.workspaceId);
      await Promise.all(
        [...this.surfaces]
          .filter(([, entry]) => entry.workspaceId === verified.workspaceId)
          .map(([id]) => this.evict(id)),
      );
      return new Response(null, { status: 200 });
    }
    const installation = await this.store.get(this.provider.provider, verified.workspaceId);
    if (!installation) return new Response(null, { status: 200 });
    return this.withSurface(
      installation,
      async (surface) =>
        (await surface.handleWebhook(this.provider.provider, verified.request)) ??
        new Response(null, { status: 404 }),
    );
  }

  async sendToThread(request: MessagingSendRequest, context: AdapterContext) {
    const scoped = await this.resolve(request.threadId, context);
    if (!scoped) {
      if (!this.fallback) throw new Error("Messaging provider unavailable");
      return this.fallback.sendToThread(request, context);
    }
    return this.withSurface(scoped.installation, (surface) =>
      surface.sendToThread({ ...request, threadId: scoped.threadId }, context),
    );
  }

  async openDirectThread(provider: string, address: string, context: AdapterContext) {
    if (provider !== this.provider.provider) {
      if (!this.fallback) throw new Error("Messaging provider unavailable");
      return this.fallback.openDirectThread(provider, address, context);
    }
    const separator = address.indexOf(":");
    if (separator < 1) throw new Error("Workspace-scoped messaging address required");
    const installation = await this.store.get(provider, address.slice(0, separator));
    this.authorize(installation, context);
    return this.withSurface(installation!, async (surface) =>
      scopeThread(
        installation!,
        await surface.openDirectThread(provider, address.slice(separator + 1), context),
      ),
    );
  }

  async acknowledge(threadId: string, handle: string, context: AdapterContext) {
    const scoped = await this.resolve(threadId, context);
    if (!scoped) return this.fallback?.acknowledge(threadId, handle, context);
    return this.withSurface(scoped.installation, (surface) =>
      surface.acknowledge(scoped.threadId, unScopeHandle(scoped.installation, handle), context),
    );
  }

  async fetchThreadHistory(
    threadId: string,
    options: { before: string; limit: number },
    context: AdapterContext,
  ) {
    const scoped = await this.resolve(threadId, context);
    if (!scoped)
      return (await this.fallback?.fetchThreadHistory?.(threadId, options, context)) ?? [];
    return this.withSurface(scoped.installation, async (surface) =>
      (
        (await surface.fetchThreadHistory?.(
          scoped.threadId,
          { ...options, before: unScopeHandle(scoped.installation, options.before) },
          context,
        )) ?? []
      ).map((event) => scopeMessage(scoped.installation, event)),
    );
  }

  private async resolve(threadId: string, context: AdapterContext) {
    const prefix = `${this.provider.provider}~`;
    if (!threadId.startsWith(prefix)) {
      // Never send an unscoped Slack thread through deployment credentials in OAuth mode.
      if (threadId.startsWith(`${this.provider.provider}:`))
        throw new Error("Workspace-scoped messaging thread required");
      return null;
    }
    const separator = threadId.indexOf(":");
    if (separator < prefix.length + 1) throw new Error("Invalid messaging thread");
    const installation = await this.store.getById(threadId.slice(prefix.length, separator));
    if (!installation) await this.evict(threadId.slice(prefix.length, separator));
    this.authorize(installation, context);
    return {
      installation: installation!,
      threadId: `${this.provider.provider}${threadId.slice(separator)}`,
    };
  }

  /** A workspace that was removed, or is not this caller's, never takes a send: no retry helps. */
  private authorize(installation: MessagingInstallation | null, context: AdapterContext) {
    if (
      !installation ||
      installation.provider !== this.provider.provider ||
      (context.spaceId && installation.spaceId !== context.spaceId)
    )
      throw new MessagingSendError(new Error("Messaging workspace unavailable"), {
        permanent: true,
        retryAfterMs: null,
      });
  }

  private async withSurface<T>(
    installation: MessagingInstallation,
    fn: (surface: MessagingSurface) => Promise<T>,
  ): Promise<T> {
    const retired: CachedSurface[] = [];
    const digest = credentialDigest(installation.credential);
    let entry = this.surfaces.get(installation.id);
    if (entry && entry.digest !== digest) {
      this.surfaces.delete(installation.id);
      retired.push(entry);
      entry = undefined;
    }
    if (!entry) {
      const surface = this.provider.surface(installation.credential);
      surface.onInbound(async (event) => {
        if (event.type === "message") await this.sink?.(scopeMessage(installation, event));
      });
      entry = { workspaceId: installation.workspaceId, digest, surface, users: 0, retired: false };
      if (this.surfaces.size >= MAX_CACHED_SURFACES) {
        const idle = [...this.surfaces].find(([, value]) => value.users === 0);
        if (idle) {
          this.surfaces.delete(idle[0]);
          retired.push(idle[1]);
        }
      }
      if (this.surfaces.size < MAX_CACHED_SURFACES) this.surfaces.set(installation.id, entry);
      else entry.retired = true;
    }
    // Publish and reserve the entry before awaiting cleanup, so concurrent callers share it.
    entry.users++;
    try {
      await Promise.all(retired.map((old) => this.retire(old)));
      return await fn(entry.surface);
    } finally {
      entry.users--;
      if (entry.retired && entry.users === 0) await entry.surface.shutdown?.();
    }
  }

  private async evict(id: string) {
    const entry = this.surfaces.get(id);
    if (!entry) return;
    this.surfaces.delete(id);
    await this.retire(entry);
  }

  private async retire(entry: CachedSurface) {
    entry.retired = true;
    if (entry.users === 0) await entry.surface.shutdown?.();
  }
}

function scopeThread(installation: MessagingInstallation, threadId: string): string {
  if (!threadId.startsWith(`${installation.provider}:`))
    throw new Error("Unexpected messaging provider");
  return `${installation.provider}~${installation.id}${threadId.slice(installation.provider.length)}`;
}
function unScopeHandle(installation: MessagingInstallation, handle: string): string {
  const prefix = `${installation.workspaceId}:`;
  if (!handle.startsWith(prefix)) throw new Error("Messaging handle belongs to another workspace");
  return handle.slice(prefix.length);
}
/** A workspace user's address as inbound messages from that workspace carry it. */
export function installationSenderAddress(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}
function scopeMessage(
  installation: MessagingInstallation,
  event: MessagingInboundMessage,
): MessagingInboundMessage {
  if (event.workspaceId && event.workspaceId !== installation.workspaceId)
    throw new Error("Messaging workspace mismatch");
  return {
    ...event,
    provider: installation.provider,
    workspaceId: installation.workspaceId,
    installationId: installation.id,
    conversationKey: `${installation.id}:${event.conversationKey ?? event.threadId}`,
    installationSpaceId: installation.spaceId,
    installationBotId: installation.botId,
    handle: `${installation.workspaceId}:${event.handle}`,
    from: installationSenderAddress(installation.workspaceId, event.from),
    participants: event.participants.map((id) =>
      installationSenderAddress(installation.workspaceId, id),
    ),
    threadId: scopeThread(installation, event.threadId),
  };
}
