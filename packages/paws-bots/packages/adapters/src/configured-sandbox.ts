import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  SecretStore,
  TerminalRequest,
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { cancelComputerRunWork, probeBackgroundWork, providerKeepsHome } from "./computer-idle.js";
import {
  computerProviderDescriptor,
  computerProviderRegistry,
} from "./computer-provider-registry.js";
import { manageComputerWorkspaceDirectories } from "./computer-workspace.js";
import { credentialDigest } from "./credential-digest.js";
import { sandboxNotFoundError } from "./sandbox-errors.js";
import { createSandboxProvider } from "./sandbox-factory.js";

export const COMPUTER_PROVIDER_SECRET_KIND = "computer-provider";
/** Record id binding the deployment's encrypted computer settings to its settings row. */
export const DEPLOYMENT_COMPUTER_PROVIDER_RECORD = "deployment-computer-provider";
/** Settings change rarely; other instances pick up a change within this window. */
const SETTINGS_TTL_MS = 5_000;
export interface StoredComputerSettings {
  provider: string;
  values: Record<string, string>;
  /** Retain other deployment connections for computers already running there. */
  connections?: Record<string, Record<string, string>>;
  /** Ciphertext identifies a credential version without retaining another plaintext copy. */
  ciphertext?: string;
}
export interface ComputerProviderSelection {
  provider: string;
  settings: StoredComputerSettings | null;
}
export function parseStoredComputerSettings(plaintext: string): StoredComputerSettings | null {
  try {
    const value = JSON.parse(plaintext);
    if (
      typeof value.provider !== "string" ||
      !value.values ||
      typeof value.values !== "object" ||
      Array.isArray(value.values) ||
      Object.values(value.values).some((v) => typeof v !== "string")
    )
      return null;
    computerProviderDescriptor(value.provider).verify(value.values);
    const connections: Record<string, Record<string, string>> = {};
    if (value.connections) {
      for (const [id, values] of Object.entries(value.connections)) {
        if (
          !values ||
          typeof values !== "object" ||
          Array.isArray(values) ||
          Object.values(values).some((entry) => typeof entry !== "string")
        )
          return null;
        computerProviderDescriptor(id).verify(values as Record<string, string>);
        connections[id] = values as Record<string, string>;
      }
    }
    return {
      provider: value.provider,
      values: value.values,
      ...(Object.keys(connections).length ? { connections } : {}),
    };
  } catch {
    return null;
  }
}
/**
 * `strict` callers route computers, so a store that cannot be read right now fails the call
 * rather than look like a removed connection; Settings stays readable so an admin can replace it.
 */
async function decryptSettings(
  secrets: Pick<SecretStore, "load">,
  secret: { id: string; ciphertext: string },
  strict: boolean,
) {
  let plaintext: string;
  try {
    plaintext = await secrets.load(secret.ciphertext, secret.id);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
  const settings = parseStoredComputerSettings(plaintext);
  return settings ? { ...settings, ciphertext: secret.ciphertext } : null;
}
export function computerSettingsForProvider(
  settings: StoredComputerSettings | null,
  provider: string,
): StoredComputerSettings | null {
  if (!settings) return null;
  const values =
    settings.provider === provider ? settings.values : settings.connections?.[provider];
  return values ? { provider, values, ciphertext: settings.ciphertext } : null;
}
export async function loadComputerProviderSelection(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  strict = false,
): Promise<ComputerProviderSelection> {
  const row = await runAsSystem("read the deployment's computer provider", () =>
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { computerProvider: true, computerProviderCipher: true },
    }),
  );
  const settings = row?.computerProviderCipher
    ? await decryptSettings(
        secrets,
        {
          id: DEPLOYMENT_COMPUTER_PROVIDER_RECORD,
          ciphertext: row.computerProviderCipher,
        },
        strict,
      )
    : null;
  return {
    provider:
      settings && settings.provider === row?.computerProvider ? settings.provider : "default",
    settings,
  };
}
export async function loadAccountComputerSettings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  userId: string,
  strict = false,
) {
  const secret = await runAsSystem("read account computer settings", () =>
    prisma.secret.findFirst({
      where: { userId, spaceId: null, kind: COMPUTER_PROVIDER_SECRET_KIND },
      orderBy: { createdAt: "desc" },
      select: { id: true, ciphertext: true },
    }),
  );
  const settings = secret ? await decryptSettings(secrets, secret, strict) : null;
  return settings && computerProviderDescriptor(settings.provider).capabilities.perAccount
    ? settings
    : null;
}
export async function loadComputerOwnerSettings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  homeKey: string,
  strict = false,
) {
  const computer = await runAsSystem("read computer owner", () =>
    prisma.computer.findUnique({ where: { homeKey }, select: { userId: true, scope: true } }),
  );
  return computer?.scope === "team"
    ? loadAccountComputerSettings(prisma, secrets, computer.userId, strict)
    : null;
}
export async function refreshComputerProvider(sandbox: SandboxProvider) {
  if (sandbox instanceof ConfiguredSandbox) await sandbox.refresh();
}

/** Resolve settings per operation; retain only the adapter for each current ciphertext. */
export class ConfiguredSandbox implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];
  private selection: ComputerProviderSelection = { provider: "default", settings: null };
  private selectionLoadedAt = 0;
  private selected?: SandboxProvider;
  private readonly owners = new Map<
    string,
    { at: number; settings: Promise<StoredComputerSettings | null> }
  >();
  private readonly providers = new Map<
    string,
    {
      ciphertext: string;
      digest: string;
      provider: Promise<SandboxProvider>;
      resolved?: SandboxProvider;
    }
  >();
  constructor(
    private readonly primary: SandboxProvider,
    private readonly load: () => Promise<ComputerProviderSelection>,
    private readonly options: {
      loadOwn?: (homeKey: string) => Promise<StoredComputerSettings | null>;
      onSecretChange?: SecretStore["onChange"];
      createProvider?: (settings: StoredComputerSettings) => Promise<SandboxProvider>;
    } = {},
  ) {
    options.onSecretChange?.((ref) => {
      for (const [key, entry] of this.providers)
        if (entry.ciphertext === ref) this.providers.delete(key);
    });
    // Bots are offered page tools only where the deployment's own computers have them.
    if (primary.pageBrowser)
      this.pageBrowser = async (computer, request, context) => {
        const provider = await this.route(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : {
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            };
      };
  }
  /** Rereads everything now; a save on this instance calls it so its change applies at once. */
  async refresh() {
    await this.reload();
    this.owners.clear();
  }
  private async reload() {
    const selection = await this.load();
    // A connection kept after going back to the default is built only when a computer needs it.
    this.selected =
      selection.settings && selection.provider !== "default"
        ? await this.providerFor(selection.settings, "deployment")
        : undefined;
    if (!selection.settings) this.forgetOwner("deployment");
    this.selection = selection;
    this.selectionLoadedAt = Date.now();
  }
  private async current() {
    if (Date.now() - this.selectionLoadedAt >= SETTINGS_TTL_MS) await this.reload();
  }
  private forgetOwner(owner: string) {
    for (const { id } of computerProviderRegistry) this.providers.delete(`${owner}:${id}`);
  }
  private providerFor(settings: StoredComputerSettings, owner: string) {
    const ciphertext = settings.ciphertext ?? credentialDigest(JSON.stringify(settings));
    const digest = credentialDigest(JSON.stringify(settings.values));
    const cached = this.providers.get(`${owner}:${settings.provider}`);
    if (cached?.ciphertext === ciphertext && cached.digest === digest) return cached.provider;
    const provider = this.options.createProvider
      ? this.options.createProvider(settings)
      : createSandboxProvider(
          settings.provider,
          computerProviderDescriptor(settings.provider).verify(settings.values),
        );
    this.providers.delete(`${owner}:${settings.provider}`);
    this.providers.set(`${owner}:${settings.provider}`, { ciphertext, digest, provider });
    if (this.providers.size > 1000) this.providers.delete(this.providers.keys().next().value!);
    provider.catch(() => {
      if (this.providers.get(`${owner}:${settings.provider}`)?.provider === provider)
        this.providers.delete(`${owner}:${settings.provider}`);
    });
    void provider.then(
      (resolved) => {
        const entry = this.providers.get(`${owner}:${settings.provider}`);
        if (entry?.provider === provider) Object.assign(entry, { resolved });
      },
      () => {},
    );
    return provider;
  }
  private async ownSettings(homeKey: string, fresh = false) {
    const cached = this.owners.get(homeKey);
    if (!fresh && cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.settings;
    const settings = Promise.resolve(this.options.loadOwn?.(homeKey) ?? null);
    this.owners.delete(homeKey);
    this.owners.set(homeKey, { at: Date.now(), settings });
    if (this.owners.size > 1000) this.owners.delete(this.owners.keys().next().value!);
    settings.then(
      (loaded) => loaded || this.forgetOwner(homeKey),
      () => this.owners.get(homeKey)?.settings === settings && this.owners.delete(homeKey),
    );
    return settings;
  }
  private async route(
    computer: Pick<ComputerRef, "kind" | "botId" | "providerRef">,
    fresh = false,
  ): Promise<SandboxProvider> {
    // Kinds Settings never selects (Docker, a local host computer) can only belong to the primary.
    const descriptor = computerProviderRegistry.find((entry) => entry.id === computer.kind);
    if (!descriptor && (this.primary.ownsReference?.(computer) ?? true)) return this.primary;
    // Only a provider an account can choose for itself ever runs that account's computers.
    const perAccount = descriptor?.capabilities.perAccount;
    // While the secret store cannot be read, route on what was last read and never call the
    // computer gone: the store failing is not evidence the connection was removed.
    let unreadable: unknown;
    const own = perAccount
      ? await this.ownSettings(computer.botId, fresh).catch((error: unknown) => {
          unreadable = error;
          return null;
        })
      : null;
    if (own?.provider === computer.kind) {
      const provider = await this.providerFor(own, computer.botId);
      if (provider.ownsReference?.(computer) ?? true) return provider;
    }
    await (fresh ? this.reload() : this.current()).catch((error: unknown) => {
      unreadable = error;
    });
    const saved = computerSettingsForProvider(this.selection.settings, computer.kind);
    if (saved) {
      const provider = await this.providerFor(saved, "deployment");
      if (provider.ownsReference?.(computer) ?? true) return provider;
    }
    const primaryKind =
      (await this.primary.provisionKind?.(computer.botId)) ?? this.primary.describe().id;
    if (computer.kind === primaryKind && (this.primary.ownsReference?.(computer) ?? true))
      return this.primary;
    if (unreadable) throw unreadable;
    // Another instance may have saved the connection since these settings were read.
    if (!fresh) return this.route(computer, true);
    // No connection reaches it any more, so it is gone: Reset and deletion can clear it and the
    // next start provisions where Settings now says.
    throw sandboxNotFoundError("The computer's provider connection is no longer configured");
  }
  private async target(homeKey?: string) {
    const own = homeKey ? await this.ownSettings(homeKey) : null;
    if (own) return this.providerFor(own, homeKey!);
    // An unreadable store must not stop every computer from starting: use the last settings read.
    await this.current().catch((error) => {
      if (!this.selectionLoadedAt) throw error;
    });
    return this.selection.provider !== "default" && this.selected ? this.selected : this.primary;
  }
  describe() {
    return (
      this.selection.provider !== "default" && this.selected ? this.selected : this.primary
    ).describe();
  }

  async provisionKind(homeKey?: string): Promise<ComputerRef["kind"]> {
    const target = await this.target(homeKey);
    if (target !== this.primary) return target.describe().id as ComputerRef["kind"];
    return (
      (await this.primary.provisionKind?.(homeKey)) ??
      (this.primary.describe().id as ComputerRef["kind"])
    );
  }

  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const target = await this.target(request.botId);
    const kind = target.describe().id;
    // A reference from the other provider means nothing to this one.
    const expectedKind = (await target.provisionKind?.(request.botId)) ?? kind;
    const providerRef = request.providerKind === expectedKind ? request.providerRef : undefined;
    return target.provision({ ...request, providerRef }, context);
  }

  async isRunning(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).isRunning?.(computer, context) ?? false;
  }

  async isStopped(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).isStopped?.(computer, context) ?? false;
  }

  async hasMountedHome(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).hasMountedHome?.(computer, context) ?? false;
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    // Asked before a new or moving computer starts, so describe where it will start.
    const provider = await this.route(computer).catch(async (error: unknown) => {
      const target = await this.target(computer.botId);
      if (target.describe().id !== computer.kind) throw error;
      return target;
    });
    return provider.environment?.(computer, context);
  }

  async workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return manageComputerWorkspaceDirectories(
      await this.route(computer),
      computer,
      request,
      context,
    );
  }

  async prepare(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* (await this.route(computer)).execute(computer, request, context);
  }

  async cancelRunWork(
    computer: ComputerRef,
    computerId: string,
    runId: string,
    context: AdapterContext,
  ) {
    return cancelComputerRunWork(await this.route(computer), computer, computerId, runId, context);
  }

  async inspectBackgroundWork(computer: ComputerRef, markerId: string, context: AdapterContext) {
    const provider = await this.route(computer);
    return provider.inspectBackgroundWork
      ? provider.inspectBackgroundWork(computer, markerId, context)
      : probeBackgroundWork(provider, computer, markerId, context);
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return (await this.route(computer)).connectScreen(computer, request, context);
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const provider = await this.route(computer);
    if (!provider.connectTerminal) throw new Error("terminal is unavailable on this computer");
    return provider.connectTerminal(computer, request, context);
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    await (await this.route(computer)).setScreenControl?.(
      computer,
      interactive,
      context,
      controlToken,
    );
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return (await this.route(computer)).sendInput(computer, input, lease, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return (await this.route(computer)).act(computer, request, context);
  }

  async listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return (await this.route(computer)).listFiles(computer, path, context);
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return (await this.route(computer)).readFile(computer, path, context, options);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return (await this.route(computer)).writeFile(computer, file, context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ) {
    yield* (await this.route(computer)).exportWorkspace(computer, context, limits);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return (await this.route(computer)).importWorkspace(computer, files, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).snapshot(computer, context);
  }

  billsWhileRunning(computer: ComputerRef): boolean {
    // The primary bills its own kinds, such as a local host computer behind Docker.
    if (
      computer.kind === this.primary.describe().id ||
      !computerProviderRegistry.some((entry) => entry.id === computer.kind)
    )
      return this.primary.billsWhileRunning?.(computer) ?? false;
    for (const entry of this.providers.values()) {
      if (entry.resolved?.describe().id === computer.kind)
        return entry.resolved.billsWhileRunning?.(computer) ?? false;
    }
    // An unresolved or invalidated remote connection must not disable idle shutdown.
    return true;
  }

  async keepsHome(computer: ComputerRef) {
    return providerKeepsHome(await this.route(computer), computer);
  }

  async keepAlive(computer: ComputerRef) {
    await (await this.route(computer)).keepAlive?.(computer);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    await (await this.route(computer)).releaseScreen?.(computer, context);
  }

  async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ) {
    return (await this.route(computer)).stop(computer, context, options);
  }

  async destroy(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).destroy(computer, context);
  }
}
