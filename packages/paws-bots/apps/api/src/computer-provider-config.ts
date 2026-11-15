import { ORPCError } from "@orpc/server";
import type { SandboxProvider, SecretStore } from "@rakazo/adapter-kit";
import type { ResolveHostname, StoredComputerSettings } from "@rakazo/adapters";
import {
  assertSafeWebUrl,
  COMPUTER_PROVIDER_SECRET_KIND,
  computerProviderDescriptor,
  computerProviderDescriptors,
  computerSettingsForProvider,
  DEPLOYMENT_COMPUTER_PROVIDER_RECORD,
  loadComputerProviderSelection,
  loadAccountComputerSettings as loadSavedAccountComputerSettings,
  refreshComputerProvider,
} from "@rakazo/adapters";
import type { Actor, ComputerProviderSettings, ComputerProviderUpdate } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export interface ComputerProviderConfigDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load" | "delete">;
  sandbox: SandboxProvider;
  env: Pick<RouterDeps["env"], "sandboxProvider" | "adminEmails" | "computerSettingsEnabled">;
  resolveHostname?: ResolveHostname;
  /** Test seam: confirm the desktop answers before saving. */
  verifyConnection?: (settings: StoredComputerSettings, signal: AbortSignal) => Promise<void>;
}

const VERIFY_TIMEOUT_MS = 20_000;

function view(
  provider: string,
  saved: StoredComputerSettings | null,
  defaultProvider: string,
  account = false,
  enabled = true,
): ComputerProviderSettings {
  if (!enabled) provider = "default";
  const values: Record<string, string> = {};
  const savedSecrets: Record<string, boolean> = {};
  if (saved && saved.provider === provider) {
    for (const field of computerProviderDescriptor(provider).fields) {
      if (field.kind === "secret") savedSecrets[field.key] = Boolean(saved.values[field.key]);
      else values[field.key] = saved.values[field.key] ?? "";
    }
  }
  return {
    provider,
    defaultProvider,
    values,
    savedSecrets,
    providers: enabled ? computerProviderDescriptors(account) : [],
  };
}

async function checkedSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  input: ComputerProviderUpdate,
  previous: StoredComputerSettings | null,
  account = false,
): Promise<StoredComputerSettings> {
  try {
    const descriptor = computerProviderDescriptor(input.provider);
    if (account && !descriptor.capabilities.perAccount)
      throw new Error("Provider does not support account settings");
    const values = { ...input.values };
    const saved = computerSettingsForProvider(previous, input.provider)?.values ?? {};
    const destinationChanged = descriptor.fields.some(
      (field) => field.kind === "url" && (values[field.key] ?? "") !== (saved[field.key] ?? ""),
    );
    for (const field of descriptor.fields) {
      if (
        field.kind === "secret" &&
        !values[field.key] &&
        !destinationChanged &&
        (!field.destination || values[field.destination] === saved[field.destination])
      )
        values[field.key] = saved[field.key] ?? "";
    }
    descriptor.verify(values);
    const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
    for (const field of descriptor.fields) {
      if (field.kind === "url" && values[field.key])
        await assertSafeWebUrl(values[field.key]!, deps.resolveHostname, signal);
    }
    // Only the connection being left stays, for computers still on it; older ones are dropped.
    const connections: Record<string, Record<string, string>> | undefined =
      !account && previous ? { [previous.provider]: previous.values } : undefined;
    if (connections) delete connections[input.provider];
    const settings = {
      provider: input.provider,
      values,
      ...(connections && Object.keys(connections).length ? { connections } : {}),
    };
    if (deps.verifyConnection) await deps.verifyConnection(settings, signal);
    else await descriptor.verifyConnection?.(values, signal);
    return settings;
  } catch (error) {
    // Provider failures and schema errors can contain credentials: log only the error's class.
    getLogger().warn("computer_provider.verify_failed", {
      provider: input.provider,
      scope: account ? "account" : "deployment",
      "user.id": actor.userId,
      "error.name": error instanceof Error ? error.name : typeof error,
    });
    throw new ORPCError("BAD_REQUEST", { message: "Could not verify computer settings" });
  }
}

function encrypt(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  settings: StoredComputerSettings,
  recordId?: string,
) {
  return deps.secrets.put(
    JSON.stringify(settings),
    {
      operationId: "computer-provider-config",
      traceId: "computer-provider-config",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
    recordId ? { recordId } : undefined,
  );
}

export async function getComputerProviderSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
): Promise<ComputerProviderSettings> {
  await requireAdmin(deps, actor.userId);
  const selection = await loadComputerProviderSelection(deps.prisma, deps.secrets);
  return view(
    selection.provider,
    selection.settings,
    deps.env.sandboxProvider,
    false,
    deploymentCanChoose(deps),
  );
}

export async function updateComputerProviderSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  input: ComputerProviderUpdate,
): Promise<ComputerProviderSettings> {
  await requireAdmin(deps, actor.userId);
  if (input.provider !== "default" && !deploymentCanChoose(deps))
    throw new ORPCError("BAD_REQUEST", { message: "This deployment cannot use computer settings" });
  const existing = await loadComputerProviderSelection(deps.prisma, deps.secrets);
  if (input.provider === "default") {
    // Going back removes the saved keys; computers still on them restart on the default.
    const removed = await runAsSystem("an admin keeps computers on the deployment provider", () =>
      deps.prisma.$transaction(async (tx) => {
        const current = await tx.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { computerProviderCipher: true },
        });
        await tx.deploymentSettings.upsert({
          where: { id: "default" },
          create: { id: "default", computerProvider: null, computerProviderCipher: null },
          update: { computerProvider: null, computerProviderCipher: null },
        });
        return current?.computerProviderCipher;
      }),
    );
    if (removed)
      await deps.secrets
        .delete(removed, DEPLOYMENT_COMPUTER_PROVIDER_RECORD)
        .catch(() => undefined);
    await refreshComputerProvider(deps.sandbox);
    return view("default", null, deps.env.sandboxProvider, false, deploymentCanChoose(deps));
  }
  // Blank secrets keep the saved ones, so an admin never has to see them again.
  const settings = await checkedSettings(deps, actor, input, existing.settings);
  // Owned by the deployment row, not a user or space, so no account deletion removes it.
  const stored = await encrypt(deps, actor, settings, DEPLOYMENT_COMPUTER_PROVIDER_RECORD);
  const forget = (ciphertext: string) =>
    deps.secrets.delete(ciphertext, DEPLOYMENT_COMPUTER_PROVIDER_RECORD).catch(() => undefined);
  let replaced: string | null | undefined;
  try {
    // Read what this save replaces in the same transaction, so concurrent saves each remove theirs.
    replaced = await withTransactionRetry(() =>
      runAsSystem("an admin configures computers", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const current = await tx.deploymentSettings.findUnique({
              where: { id: "default" },
              select: { computerProviderCipher: true },
            });
            await tx.deploymentSettings.upsert({
              where: { id: "default" },
              create: {
                id: "default",
                computerProvider: input.provider,
                computerProviderCipher: stored.ciphertext,
              },
              update: {
                computerProvider: input.provider,
                computerProviderCipher: stored.ciphertext,
              },
            });
            return current?.computerProviderCipher;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  } catch (error) {
    await forget(stored.ciphertext);
    throw error;
  }
  if (replaced && replaced !== stored.ciphertext) await forget(replaced);
  await refreshComputerProvider(deps.sandbox);
  return view(input.provider, settings, deps.env.sandboxProvider);
}

/** Where computers run while an account keeps the deployment default. */
async function deploymentProvider(deps: ComputerProviderConfigDeps) {
  // Only a saved connection that still reads counts; otherwise computers use the environment's.
  const selection = await loadComputerProviderSelection(deps.prisma, deps.secrets);
  if (!routesBySettings(deps.env.sandboxProvider) || selection.provider === "default")
    return deps.env.sandboxProvider;
  return selection.provider;
}

/** Account computer settings. */
export async function getAccountComputerSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
): Promise<ComputerProviderSettings> {
  const [saved, defaultProvider] = await Promise.all([
    loadSavedAccountComputerSettings(deps.prisma, deps.secrets, actor.userId),
    deploymentProvider(deps),
  ]);
  return view(
    saved?.provider ?? "default",
    saved,
    defaultProvider,
    true,
    // An account with saved keys still sees the form, so it can go back to the default.
    Boolean(deps.env.computerSettingsEnabled) &&
      (accountCanChoose(defaultProvider) || Boolean(saved)),
  );
}

export async function updateAccountComputerSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  input: ComputerProviderUpdate,
): Promise<ComputerProviderSettings> {
  // Those deployments run every computer on their own provider, never one chosen in Settings,
  // and one without computers has none for an account's private computers to fall back on.
  // Going back to the default stays open, so an account can always remove its saved keys.
  if (
    input.provider !== "default" &&
    (!deps.env.computerSettingsEnabled || !accountCanChoose(await deploymentProvider(deps)))
  )
    throw new ORPCError("BAD_REQUEST", {
      message: "This deployment cannot use account computer settings",
    });
  const mine = { userId: actor.userId, spaceId: null, kind: COMPUTER_PROVIDER_SECRET_KIND };
  let saved: StoredComputerSettings | null = null;
  let replaced: { id: string; ciphertext: string }[] = [];
  if (input.provider === "default") {
    // The account's computers move to the deployment's desktop the next time they start.
    replaced = await runAsSystem("an account goes back to the deployment's computers", () =>
      deps.prisma.$transaction(async (tx) => {
        const rows = await tx.secret.findMany({
          where: mine,
          select: { id: true, ciphertext: true },
        });
        await tx.secret.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
        return rows;
      }),
    );
  } else {
    const previous = await loadSavedAccountComputerSettings(
      deps.prisma,
      deps.secrets,
      actor.userId,
    );
    saved = await checkedSettings(deps, actor, input, previous, true);
    const stored = await encrypt(deps, actor, saved);
    try {
      replaced = await withTransactionRetry(() =>
        runAsSystem("an account saves computer settings", () =>
          deps.prisma.$transaction(
            async (tx) => {
              // Account-level, so it outlives any one space and only its owner can read it.
              const secret = await tx.secret.create({
                data: { ...mine, id: stored.id, ciphertext: stored.ciphertext },
              });
              const rows = await tx.secret.findMany({
                where: { ...mine, id: { not: secret.id } },
                select: { id: true, ciphertext: true },
              });
              await tx.secret.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
              return rows;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        ),
      );
    } catch (error) {
      await deps.secrets.delete(stored.ciphertext, stored.id).catch(() => undefined);
      throw error;
    }
  }
  // A remote secret store keeps every saved value until it is deleted there too.
  await Promise.all(
    replaced.map((row) => deps.secrets.delete(row.ciphertext, row.id).catch(() => undefined)),
  );
  await refreshComputerProvider(deps.sandbox);
  return view(
    saved?.provider ?? "default",
    saved,
    await deploymentProvider(deps),
    true,
    Boolean(deps.env.computerSettingsEnabled),
  );
}

function deploymentCanChoose(deps: ComputerProviderConfigDeps) {
  return Boolean(deps.env.computerSettingsEnabled) && routesBySettings(deps.env.sandboxProvider);
}

/** Whether computers on this deployment can run where Settings says. */
function routesBySettings(envProvider: string) {
  return envProvider !== "desktop" && envProvider !== "fake";
}

function accountCanChoose(deploymentProvider: string) {
  return (
    routesBySettings(deploymentProvider) && deploymentProvider !== "none" && !!deploymentProvider
  );
}

/** Where the deployment's computers run once an admin's choice in Settings applies. */
export function effectiveSandboxProvider(
  settings: { computerProvider?: string | null; computerProviderCipher?: string | null } | null,
  envProvider: string,
) {
  if (!routesBySettings(envProvider)) return envProvider;
  return (settings?.computerProviderCipher && settings.computerProvider) || envProvider;
}
