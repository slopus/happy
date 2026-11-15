import { homedir } from "node:os";
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
import { draftRecordingsOfLease, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork, providerKeepsHome } from "./computer-idle.js";
import { computerProviderDescriptor } from "./computer-provider-registry.js";
import { manageComputerWorkspaceDirectories } from "./computer-workspace.js";
import {
  ConfiguredSandbox,
  loadComputerOwnerSettings,
  loadComputerProviderSelection,
} from "./configured-sandbox.js";
import { assertHostCommandsAllowed, DesktopSandboxProvider } from "./desktop-sandbox.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { createSandboxProvider } from "./sandbox-factory.js";

export function sandboxKindForBot(envKind: string, computerHost: string | null | undefined) {
  if (envKind === "docker" && computerHost === "this-mac") return "desktop";
  return envKind;
}

export async function createRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & {
    prisma?: PrismaClient;
    secrets?: Pick<SecretStore, "load" | "onChange">;
  },
): Promise<SandboxProvider> {
  const base = await createBaseRunSandbox(kind, opts);
  // With the database at hand, Settings can send computers elsewhere: an admin's choice for
  // everyone, or an account's own provider.
  if (!opts.prisma || !opts.secrets || kind === "desktop" || kind === "fake") return base;
  const { prisma, secrets } = opts;
  const configured = new ConfiguredSandbox(
    base,
    () => loadComputerProviderSelection(prisma, secrets, true),
    {
      onSecretChange: secrets.onChange?.bind(secrets),
      loadOwn: (homeKey) => loadComputerOwnerSettings(prisma, secrets, homeKey, true),
      createProvider: (settings) =>
        createBaseRunSandbox(settings.provider, {
          ...opts,
          ...computerProviderDescriptor(settings.provider).verify(settings.values),
        }),
    },
  );
  // Startup never waits on the secret store or a saved provider: routing rereads them on first use.
  await configured
    .refresh()
    .catch((error) => getLogger().warn("computer_provider.load_failed", { error }));
  return configured;
}

async function createBaseRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & { prisma?: PrismaClient },
): Promise<SandboxProvider> {
  if (kind === "desktop") {
    assertHostCommandsAllowed();
    return new DesktopSandboxProvider({
      root: opts.dataDir,
      hostRoots: [homedir()],
    });
  }
  const prisma = opts.prisma;
  const primary = await createSandboxProvider(kind, {
    ...opts,
    referenceInUse: prisma
      ? async (computer) =>
          (await runAsSystem("check whether another computer shares a provider resource", () =>
            prisma.computer.count({
              where: {
                kind: computer.kind,
                providerRef: computer.providerRef,
                homeKey: { not: computer.botId },
                // One still saving its workspace needs the desktop until it finishes.
                state: { in: ["booting", "running", "suspending"] },
              },
            }),
          )) > 0
      : opts.referenceInUse,
    onUnsafeStop: opts.prisma
      ? async (providerRef) => {
          // Quarantine ends any person's control; a recording made under it ends with it.
          const held = await opts.prisma!.computer.findMany({
            where: { kind, providerRef, controlLeaseId: { not: null } },
            select: { spaceId: true, controlLeaseId: true },
          });
          const quarantined = await opts.prisma!.computer.updateMany({
            where: { kind, providerRef },
            data: {
              state: "quarantined",
              screenUrl: null,
              screenGeneration: { increment: 1 },
              controlFence: { increment: 1 },
              controlHolder: "none",
              controlLeaseId: null,
              controlUserId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
            },
          });
          if (quarantined.count === 0)
            throw new Error("Computer recovery requirement could not be recorded");
          for (const { spaceId, controlLeaseId } of held) {
            await draftRecordingsOfLease(opts.prisma!, { spaceId, leaseId: controlLeaseId! });
          }
        }
      : opts.onUnsafeStop,
  });
  if (kind !== "docker" || !opts.prisma) return primary;
  return new HostAwareSandbox(
    primary,
    new HostComputerSandbox(opts.hostComputerUrl ?? "", opts.hostComputerToken ?? ""),
    async () => {
      const settings = await opts.prisma!.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      return settings?.computerHost === "this-mac";
    },
  );
}

export class HostAwareSandbox implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  constructor(
    private readonly isolated: SandboxProvider,
    private readonly host: SandboxProvider,
    private readonly hostEnabled: () => Promise<boolean>,
  ) {
    if (isolated.pageBrowser || host.pageBrowser) {
      this.pageBrowser = (computer, request, context) => {
        const provider = this.route(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : Promise.resolve({
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            });
      };
    }
  }

  ownsReference(computer: Pick<ComputerRef, "kind" | "providerRef">) {
    return this.route(computer).ownsReference?.(computer) ?? true;
  }

  describe() {
    return this.isolated.describe();
  }

  private route(computer: Pick<ComputerRef, "kind">) {
    return computer.kind === "desktop" ? this.host : this.isolated;
  }

  async provisionKind() {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    return provider.describe().id as ComputerRef["kind"];
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ) {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    const providerKind = provider.describe().id;
    return provider.provision(
      {
        ...request,
        providerRef: request.providerKind === providerKind ? request.providerRef : undefined,
      },
      context,
    );
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    if (provider.describe().id !== computer.kind) return false;
    return provider.isRunning?.(computer, context) ?? false;
  }

  async isStopped(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    return this.route(computer).isStopped?.(computer, context) ?? false;
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    const provider = this.route(computer);
    return provider.environment?.(computer, context);
  }

  prepare(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (computer.kind === "desktop" && !(await this.hostEnabled()))
      throw new Error("Local computer access is disabled");
    yield* this.route(computer).execute(computer, request, context);
  }

  workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return manageComputerWorkspaceDirectories(this.route(computer), computer, request, context);
  }

  cancelRunWork(computer: ComputerRef, computerId: string, runId: string, context: AdapterContext) {
    return cancelComputerRunWork(this.route(computer), computer, computerId, runId, context);
  }

  connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.route(computer).connectScreen(computer, request, context);
  }

  connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const provider = this.route(computer);
    if (!provider.connectTerminal) {
      return Promise.reject(new Error("terminal is unavailable on this computer"));
    }
    return provider.connectTerminal(computer, request, context);
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.route(computer).sendInput(computer, input, lease, context);
  }

  observe(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).observe(computer, context);
  }

  act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.route(computer).act(computer, request, context);
  }

  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.route(computer).listFiles(computer, path, context);
  }

  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return this.route(computer).readFile(computer, path, context, options);
  }

  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return this.route(computer).writeFile(computer, file, context);
  }

  exportWorkspace(computer: ComputerRef, context: AdapterContext, limits?: WorkspaceExportLimits) {
    return this.route(computer).exportWorkspace(computer, context, limits);
  }

  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return this.route(computer).importWorkspace(computer, files, context);
  }

  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).snapshot(computer, context);
  }

  billsWhileRunning(computer: Pick<ComputerRef, "kind">): boolean {
    return this.route(computer).billsWhileRunning?.(computer) ?? false;
  }

  keepsHome(computer: ComputerRef) {
    return providerKeepsHome(this.route(computer), computer);
  }

  keepAlive(computer: ComputerRef) {
    return this.route(computer).keepAlive?.(computer) ?? Promise.resolve();
  }

  releaseScreen(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).releaseScreen?.(computer, context) ?? Promise.resolve();
  }

  setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return (
      this.route(computer).setScreenControl?.(computer, interactive, context, controlToken) ??
      Promise.resolve()
    );
  }

  stop(computer: ComputerRef, context: AdapterContext, options?: { discardUnsaved?: boolean }) {
    return this.route(computer).stop(computer, context, options);
  }

  destroy(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).destroy(computer, context);
  }
}
