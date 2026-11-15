import { ORPCError } from "@orpc/server";
import {
  deploymentModelRole,
  findConnectedModelCredential,
  hasHostedModelCredits,
  hostCredentialSource,
  mcpStdioAvailable,
  resolveMemberMainModel,
  selectConfiguredModel,
} from "@rakazo/adapters";
import type { Actor, Me } from "@rakazo/contracts";
import {
  attachmentMaxBytes,
  attachmentMaxCount,
  canonicalPiProviderId,
  modelCreditsUsd,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import { isAdmin } from "../admins.js";
import { effectiveSandboxProvider } from "../computer-provider-config.js";
import type { RouterDeps } from "../router.js";

export { createAdapterContext as computerContext } from "@rakazo/adapter-kit";

function hostCredentials(active: boolean, provider: string) {
  return active
    ? { hostCredentialProvider: provider, hostCredentialSource: hostCredentialSource(provider) }
    : { hostCredentialProvider: null, hostCredentialSource: null };
}

export async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup, admin] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: {
        email: true,
        name: true,
        timezone: true,
        locale: true,
        botAvatarSet: true,
        signupSurvey: { select: { userId: true } },
      },
    }),
    modelSetup(deps, actor),
    isAdmin(deps, actor.userId),
  ]);
  // Where the deployment runs computers once an admin's choice in Settings applies.
  const sandboxProvider = effectiveSandboxProvider(setup.settings, deps.env.sandboxProvider);
  return {
    ticketBoardEnabled: deps.env.ticketBoardEnabled === true,
    phoneCallsEnabled: deps.env.phoneCallsEnabled === true,
    navLinks: deps.env.navLinks ?? [],
    maxUploadSizeBytes: attachmentMaxBytes(deps.env),
    maxAttachmentsPerMessage: attachmentMaxCount(deps.env),
    userId: actor.userId,
    email: user.email,
    name: user.name,
    spaceId: actor.spaceId,
    isDeploymentOwner: false,
    isAdmin: admin,
    needsModel: setup.needsModel,
    defaultProvider: canonicalPiProviderId(setup.model?.provider ?? deps.env.defaultProvider),
    defaultModel: setup.model?.modelId ?? deps.env.defaultModel,
    // Set only while the active default is the deployment's own, running on host credentials.
    ...hostCredentials(
      !setup.main &&
        !setup.settings?.defaultModelProvider &&
        Boolean(deps.env.deploymentModelHostCredentials),
      deps.env.defaultProvider,
    ),
    computerHost: computerHostFor(setup.settings?.computerHost, sandboxProvider),
    canChooseHostComputer:
      Boolean(deps.env.desktopHostChoiceEnabled) && sandboxProvider === "docker",
    // The deployment's provider: an account's own choice covers only its Team Computers.
    sandboxProvider,
    computerSettingsEnabled: Boolean(deps.env.computerSettingsEnabled),
    mcpStdioEnabled:
      admin &&
      mcpStdioAvailable({
        stdioEnabled: deps.env.mcpStdioEnabled,
        allowedCommands: deps.env.mcpStdioAllowedCommands,
      }),
    avatarStyle: "organic",
    botAvatarSet: resolveBotAvatarSet(user.botAvatarSet),
    timezone: user.timezone ?? null,
    locale: user.locale ?? null,
    billingEnabled: Boolean(deps.billing),
    // Only billing deployments ask; self-hosted installs never see the survey.
    needsSignupSurvey: Boolean(deps.billing) && !user.signupSurvey,
    paymentWalletProvider: deps.paymentWallet
      ? { id: deps.paymentWallet.describe().id, name: deps.paymentWallet.displayName }
      : null,
  };
}

function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (sandboxProvider !== "docker") return null;
  if (stored === "this-mac" || stored === "docker") return stored;
  return null;
}

/** The main model chat runs: the member's while it can run, else the deployment's. */
export async function modelSetup(deps: RouterDeps, actor: Actor) {
  const [member, settings] = await Promise.all([
    resolveMemberMainModel({ prisma: deps.prisma, secretStore: deps.secrets }, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const main =
    member &&
    (member.credential ||
      (deps.billing?.modelCreditsEnabled &&
        (await hasHostedModelCredits(deps.prisma, actor, member.provider))))
      ? member
      : null;
  const funding = deps.billing ? await deps.billing.status(actor) : null;
  const creditsAvailable = modelCreditsUsd(funding) !== null;
  const hasDeployment =
    Boolean(deps.env.deploymentModelConfigured) &&
    (!funding?.creditPurchasesEnabled || creditsAvailable);
  return {
    main,
    model:
      main ??
      deploymentModelRole("main", {
        settings,
        deployment: { provider: deps.env.defaultProvider, model: deps.env.defaultModel },
      }).primary,
    settings,
    funding,
    creditsAvailable,
    hasDeployment,
    needsModel: deps.env.agentRuntime !== "scripted" && !main && !hasDeployment,
  };
}

/** Whether every bot runs its own model on one of the member's connections, as a run selects it. */
export async function botsRunOwnModels(deps: RouterDeps, actor: Actor, botIds: string[]) {
  const bots = await deps.prisma.bot.findMany({
    where: { id: { in: botIds }, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  const credentials = await Promise.all(
    bots.map(async (bot) => {
      const overrideCredential = bot.modelProvider
        ? await findConnectedModelCredential(
            deps.prisma,
            deps.secrets,
            actor,
            bot.modelProvider,
            bot.modelId,
          )
        : null;
      return selectConfiguredModel({ override: bot, overrideCredential, main: null, defaults: {} })
        .credential;
    }),
  );
  return credentials.every(Boolean);
}

export const THREAD_MESSAGE_PAGE_SIZE = 100;

/** Silence longer than this on a thread stream is indistinguishable from a dead socket. */
export const HEARTBEAT_MS = 20_000;

/** A thread stream re-checks its session at least this often while it delivers. */
export const SESSION_RECHECK_MS = 10_000;

export const HEARTBEAT = Symbol("heartbeat");

const ENDED = Symbol("ended");

/**
 * Yields each event from `follow`, or HEARTBEAT after HEARTBEAT_MS of silence: a half-open stream
 * looks identical to an idle one, and clients treat any frame as liveness. Auth ran once when the
 * stream opened, so before yielding anything this re-checks the session if SESSION_RECHECK_MS has
 * passed; a signed-out or revoked session ends the stream with UNAUTHORIZED.
 */
export async function* withHeartbeats<T>(
  context: { signal?: AbortSignal; stillAuthorized?: () => Promise<boolean> },
  follow: (signal: AbortSignal) => AsyncGenerator<T>,
): AsyncGenerator<T | typeof HEARTBEAT> {
  const controller = new AbortController();
  const source = follow(
    context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal,
  );
  let pending: Promise<IteratorResult<T>> | undefined;
  let authorizedAt = Date.now();
  try {
    while (!context.signal?.aborted) {
      // A heartbeat keeps `pending`, so the in-flight read stays the next event in order.
      pending ??= source.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const next = await Promise.race([
        pending,
        // Racing the abort ends a source that ignores it, so its session re-checks can't run after
        // shutdown has closed the database pool. The waiter is per read so a settled race, and the
        // event it carried, isn't retained until disconnect.
        new Promise<typeof HEARTBEAT | typeof ENDED>((resolve) => {
          timer = setTimeout(() => resolve(HEARTBEAT), HEARTBEAT_MS);
          if (context.signal?.aborted) return resolve(ENDED);
          onAbort = () => resolve(ENDED);
          context.signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (onAbort) context.signal?.removeEventListener("abort", onAbort);
      });
      if (next === ENDED || context.signal?.aborted) return;
      if (context.stillAuthorized && Date.now() - authorizedAt >= SESSION_RECHECK_MS) {
        if (!(await context.stillAuthorized())) throw new ORPCError("UNAUTHORIZED");
        authorizedAt = Date.now();
      }
      if (next === HEARTBEAT) {
        yield HEARTBEAT;
        continue;
      }
      pending = undefined;
      if (next.done) return;
      yield next.value;
    }
  } finally {
    controller.abort();
    // Not awaited: closing queues behind an in-flight read until the abort lands on it, and the
    // stream (including an UNAUTHORIZED end) must not wait for that.
    void source.return(undefined).catch(() => {});
  }
}

/** Interleaves streams in arrival order; one that fails ends the rest, and stopping ends them all. */
export async function* mergeStreams<T extends unknown[]>(
  ...sources: { [K in keyof T]: AsyncGenerator<T[K]> }
): AsyncGenerator<T[number]> {
  const streams: AsyncGenerator<T[number]>[] = sources;
  const reads = new Map<number, Promise<{ index: number; result: IteratorResult<T[number]> }>>();
  const read = (index: number, stream: AsyncGenerator<T[number]>) => {
    const pending = stream.next().then((result) => ({ index, result }));
    // Raced on the next loop; this only keeps a rejection while the consumer is paused handled.
    pending.catch(() => {});
    // Re-adding moves this stream behind the others, so a busy one cannot starve the rest.
    reads.delete(index);
    reads.set(index, pending);
  };
  for (const [index, stream] of streams.entries()) read(index, stream);
  try {
    while (reads.size > 0) {
      const { index, result } = await Promise.race(reads.values());
      if (result.done) {
        reads.delete(index);
        continue;
      }
      read(index, streams[index]!);
      yield result.value;
    }
  } finally {
    for (const pending of reads.values()) pending.catch(() => {});
    for (const stream of streams) void stream.return(undefined).catch(() => {});
  }
}
