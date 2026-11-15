import { randomBytes } from "node:crypto";
import type {
  JobPublisher,
  MessagingInstallation,
  MessagingInstallationStore,
  MessagingInstallProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { Actor, MessagingInstallationSummary } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { credentialDigest } from "./credential-digest.js";
import { installationSenderAddress } from "./installed-messaging-surface.js";

/** OAuth state is short-lived, single-use and tied to a user, space and bot. */
export class MessagingInstallations implements MessagingInstallationStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    readonly provider: MessagingInstallProvider,
    private readonly cleanupJobs?: Pick<JobPublisher, "enqueue">,
  ) {}

  /** Without a chosen bot, the workspace answers as the user's first bot in the current space. */
  async start(actor: Actor, botId?: string): Promise<string> {
    const bot = botId
      ? await this.prisma.bot.findFirst({
          where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
          select: { id: true, spaceId: true },
        })
      : await this.defaultBot(actor);
    if (!bot) throw new IsolationError("Bot not found");
    const state = randomBytes(32).toString("base64url");
    await runAsSystem("start messaging workspace installation", async () => {
      await this.prisma.messagingInstallSession.deleteMany({
        where: { userId: actor.userId, expiresAt: { lt: new Date() } },
      });
      await this.prisma.messagingInstallSession.create({
        data: {
          id: credentialDigest(state),
          provider: this.provider.provider,
          spaceId: bot.spaceId,
          userId: actor.userId,
          botId: bot.id,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
    });
    return this.provider.authorizeUrl(state);
  }

  private defaultBot(actor: Actor) {
    return runAsSystem("resolve default messaging bot", () =>
      this.prisma.bot.findFirst({
        where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, spaceId: true },
      }),
    );
  }

  /** Only the user who started it may finish, so a forwarded authorize link cannot attach their workspace. */
  async complete(actor: Actor, state: string, code: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096)
      throw new Error("Invalid authorization");
    await runAsSystem("complete messaging workspace installation", async () => {
      const session = await this.prisma.messagingInstallSession.findUnique({
        where: { id: credentialDigest(state) },
      });
      if (
        !session ||
        session.userId !== actor.userId ||
        session.provider !== this.provider.provider ||
        session.expiresAt <= new Date()
      )
        throw new Error("Authorization expired");
      const claimed = await this.prisma.messagingInstallSession.deleteMany({
        where: { id: session.id, expiresAt: { gt: new Date() } },
      });
      if (claimed.count !== 1) throw new Error("Authorization expired");
      // Membership and bot ownership can change while Slack is authorizing.
      const bot = await this.prisma.bot.findFirst({
        where: {
          id: session.botId,
          spaceId: session.spaceId,
          userId: session.userId,
          archivedAt: null,
        },
      });
      const member = await this.prisma.spaceMember.findFirst({
        where: { spaceId: session.spaceId, userId: session.userId },
      });
      if (!bot || !member) throw new Error("Installation owner is no longer available");
      const external = await this.provider.exchange(code);
      const where = {
        provider_workspaceId: { provider: session.provider, workspaceId: external.workspaceId },
      };
      const existing = await this.prisma.messagingInstallation.findUnique({ where });
      if (
        existing &&
        (existing.spaceId !== session.spaceId ||
          existing.userId !== session.userId ||
          existing.botId !== session.botId)
      ) {
        throw new Error("Workspace is already connected");
      }
      const id = existing?.id ?? randomBytes(16).toString("hex");
      const ownerAddress = external.ownerId
        ? installationSenderAddress(external.workspaceId, external.ownerId)
        : null;
      const previousCiphertext = existing?.ciphertext;
      const sealed = await this.secrets.put(
        external.credential,
        {
          operationId: id,
          traceId: id,
          spaceId: session.spaceId,
          userId: session.userId,
          signal: AbortSignal.timeout(10_000),
        },
        { recordId: id },
      );
      try {
        if (existing) {
          // Compare owner and previous ciphertext: disconnect/reinstall must not be undone.
          const updated = await this.prisma.messagingInstallation.updateMany({
            where: {
              id,
              spaceId: session.spaceId,
              userId: session.userId,
              botId: session.botId,
              ciphertext: previousCiphertext,
            },
            data: {
              ciphertext: sealed.ciphertext,
              workspaceName: external.workspaceName,
              ownerAddress,
            },
          });
          if (updated.count !== 1) throw new Error("Workspace connection changed; try again");
        } else {
          // The unique workspace key prevents concurrent installs claiming two tenants.
          await this.prisma.messagingInstallation.create({
            data: {
              id,
              provider: session.provider,
              workspaceId: external.workspaceId,
              workspaceName: external.workspaceName,
              spaceId: session.spaceId,
              userId: session.userId,
              botId: session.botId,
              ciphertext: sealed.ciphertext,
              ownerAddress,
            },
          });
        }
      } catch (error) {
        // A transport error may happen after a committed write; never remove a referenced secret.
        try {
          const current = await this.prisma.messagingInstallation.findUnique({
            where: { id },
            select: { ciphertext: true },
          });
          if (current?.ciphertext !== sealed.ciphertext)
            await this.cleanupCredential(sealed.ciphertext, id);
        } catch {
          getLogger().warn("unused messaging credential cleanup failed");
        }
        throw error;
      }
      if (previousCiphertext && previousCiphertext !== sealed.ciphertext)
        await this.cleanupCredential(previousCiphertext, id);
    });
  }

  /** A user's workspaces from every space they belong to: the connection is theirs, not the space's. */
  async list(actor: Actor): Promise<MessagingInstallationSummary[]> {
    const rows = await runAsSystem("list a user's messaging workspaces", () =>
      this.prisma.messagingInstallation.findMany({
        where: {
          provider: this.provider.provider,
          userId: actor.userId,
          space: { memberships: { some: { userId: actor.userId } } },
        },
        select: {
          id: true,
          provider: true,
          workspaceName: true,
          botId: true,
          bot: { select: { name: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
    );
    return rows.map(({ bot, ...row }) => ({ ...row, botName: bot.name }));
  }

  /** A teammate's workspace in this space accepts the user's DM link; their own rows link directly. */
  async canLinkPersonalMessages(actor: Actor): Promise<boolean> {
    return runAsSystem("check space messaging link availability", async () => {
      const candidates = await this.prisma.messagingInstallation.findMany({
        where: {
          provider: this.provider.provider,
          spaceId: actor.spaceId,
          userId: { not: actor.userId },
          space: { memberships: { some: { userId: actor.userId } } },
        },
        select: { id: true },
      });
      for (const { id } of candidates) {
        if (await this.activeRow({ id })) return true;
      }
      return false;
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await runAsSystem("disconnect a user's messaging workspace", async () => {
      const installation = await this.prisma.messagingInstallation.findFirst({
        where: { id, userId: actor.userId },
      });
      if (installation) await this.removeOwned(installation);
    });
  }

  async removeForBot(bot: { id: string; spaceId: string; userId: string }): Promise<void> {
    await runAsSystem("disconnect deleted bot messaging installations", async () => {
      const installations = await this.prisma.messagingInstallation.findMany({
        where: { botId: bot.id, spaceId: bot.spaceId, userId: bot.userId },
      });
      for (const installation of installations) await this.removeOwned(installation);
    });
  }

  async targets(): Promise<Array<{ id: string; botId: string; workspaceId: string }>> {
    return runAsSystem("resume installed messaging conversations", () =>
      this.prisma.messagingInstallation.findMany({
        where: { provider: this.provider.provider, bot: { archivedAt: null } },
        select: { id: true, botId: true, workspaceId: true },
      }),
    );
  }

  private async removeOwned(installation: {
    id: string;
    provider: string;
    spaceId: string;
    userId: string;
    ciphertext: string;
  }) {
    const removed = await this.prisma.$transaction(async (tx) => {
      await tx.messagingIdentity.deleteMany({
        where: {
          spaceId: installation.spaceId,
          provider: installation.provider,
          dmThreadId: { startsWith: `${installation.provider}~${installation.id}:` },
        },
      });
      const result = await tx.messagingInstallation.deleteMany({
        where: {
          id: installation.id,
          spaceId: installation.spaceId,
          userId: installation.userId,
          ciphertext: installation.ciphertext,
        },
      });
      if (result.count !== 1) throw new Error("Workspace connection changed; try again");
      return true;
    });
    if (removed) await this.cleanupCredential(installation.ciphertext, installation.id);
  }

  async isActive(id: string): Promise<boolean> {
    return runAsSystem("check messaging workspace membership", async () =>
      Boolean(await this.activeRow({ id })),
    );
  }

  get(provider: string, workspaceId: string) {
    return this.load({ provider_workspaceId: { provider, workspaceId } });
  }

  async removeWorkspace(provider: string, workspaceId: string): Promise<void> {
    await runAsSystem("remove uninstalled messaging workspace", async () => {
      const installation = await this.prisma.messagingInstallation.findUnique({
        where: { provider_workspaceId: { provider, workspaceId } },
      });
      if (installation) await this.removeOwned(installation);
    });
  }

  getById(id: string) {
    return this.load({ id });
  }

  private async load(
    where: { id: string } | { provider_workspaceId: { provider: string; workspaceId: string } },
  ): Promise<MessagingInstallation | null> {
    return runAsSystem("resolve verified messaging installation", async () => {
      const row = await this.activeRow(where);
      if (!row) return null;
      const { ciphertext, ...installation } = row;
      return { ...installation, credential: await this.secrets.load(ciphertext, row.id) };
    });
  }
  private async cleanupCredential(ref: string, installationId: string): Promise<void> {
    try {
      await this.secrets.delete(ref, installationId);
    } catch {
      getLogger().warn("messaging credential cleanup failed; queuing retry");
      try {
        await this.cleanupJobs?.enqueue({
          name: "messaging.credential-cleanup",
          payload: { installationId, ref },
          replaceKey: `messaging.credential-cleanup:${credentialDigest(ref)}`,
          maxAttempts: 20,
        });
      } catch {
        getLogger().warn("messaging credential cleanup retry could not be queued");
      }
    }
  }

  private async activeRow(
    where: { id: string } | { provider_workspaceId: { provider: string; workspaceId: string } },
  ) {
    const row = await this.prisma.messagingInstallation.findUnique({ where });
    if (!row) return null;
    const [bot, member] = await Promise.all([
      this.prisma.bot.findFirst({
        where: { id: row.botId, spaceId: row.spaceId, userId: row.userId, archivedAt: null },
        select: { id: true },
      }),
      this.prisma.spaceMember.findFirst({
        where: { spaceId: row.spaceId, userId: row.userId },
        select: { id: true },
      }),
    ]);
    return bot && member ? row : null;
  }
}
