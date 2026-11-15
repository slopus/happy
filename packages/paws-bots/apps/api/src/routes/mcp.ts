import { ORPCError } from "@orpc/server";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  lockMcpOAuthMaterial,
  McpOAuthClientRequiredError,
  persistPreparedSecret,
  recordMcpServerHealth,
} from "@rakazo/adapters";
import { MCP_OAUTH_REDIRECT_MISMATCH } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import {
  AVAILABILITY_SELECT,
  availableInSpace,
  IsolationError,
  isUniqueViolation,
  itemSecretIn,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  assertNameFreeWhereAvailable,
  lockOwner,
  serverAvailability,
  serverSecretSpace,
} from "../availability.js";
import {
  queueMcpConnectedRun,
  resolveMcpApprovalCards,
  revertConnectedMcpApprovals,
} from "../mcp-approval.js";
import { buildMcpUpdateMaterial, legacyMcpArgs } from "../mcp-material.js";
import {
  assertMcpOAuthTemplates,
  assertMcpRemoteEndpoint,
  assertMcpStdioAdmin,
  assertMcpStdioCommand,
  MCP_OAUTH_PENDING_MESSAGE,
  mcpAssignmentDto,
  mcpServerDto,
} from "../mcp-servers.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

export function mcpRoutes(ctx: RouterContext) {
  const {
    deps,
    onboardingDeps,
    mcpOAuth,
    mcpAwaitsOAuth,
    probeMcpServer,
    beginMcpProbe,
    removeMcpServerInTransaction,
    prepareMcpServer,
    insertMcpServer,
    announceMcpServer,
    authed,
  } = ctx;
  return {
    mcp: {
      servers: {
        list: authed.mcp.servers.list.handler(async ({ context }) => {
          const rows = await deps.prisma.mcpServer.findMany({
            where: availableInSpace(context.actor),
            include: { availableIn: AVAILABILITY_SELECT },
            orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          });
          const secretIds = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
          const secrets = secretIds.length
            ? await deps.prisma.secret.findMany({
                where: {
                  id: { in: secretIds },
                  ...itemSecretIn(context.actor),
                },
                select: { id: true, ciphertext: true },
              })
            : [];
          const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
          return Promise.all(
            rows.map(async (row) =>
              mcpServerDto(
                row,
                await mcpOAuth.summaryForCiphertext(
                  row.secretId ? ciphertextById.get(row.secretId) : undefined,
                  row.secretId ?? undefined,
                ),
              ),
            ),
          );
        }),
        create: authed.mcp.servers.create.handler(async ({ context, input }) => {
          const stored = await prepareMcpServer(context.actor, input);
          const row = await deps.prisma
            .$transaction((tx) =>
              insertMcpServer(tx, context.actor, input, stored, { everywhere: true }),
            )
            .catch((error: unknown) => {
              // The slug comes from the name, so this is a second server with the same name.
              if (isUniqueViolation(error)) {
                throw new ORPCError("CONFLICT", {
                  message: "An MCP server with that name already exists.",
                });
              }
              throw error;
            });
          return announceMcpServer(row, context.actor);
        }),
        update: authed.mcp.servers.update.handler(async ({ context, input }) => {
          for (let attempt = 0; attempt < 5; attempt++) {
            const { existing, existingSecret } = await deps.prisma.$transaction(async (tx) => {
              const existing = await tx.mcpServer.findFirst({
                where: {
                  id: input.id,
                  ...availableInSpace(context.actor),
                },
              });
              if (!existing) throw new IsolationError();
              const existingSecret = existing.secretId
                ? await tx.secret.findFirst({
                    where: {
                      id: existing.secretId,
                      ...itemSecretIn(context.actor),
                    },
                  })
                : null;
              return { existing, existingSecret };
            });
            let existingMaterial: Record<string, unknown> = {};
            if (existingSecret) {
              try {
                const value = JSON.parse(
                  await deps.secrets.load(existingSecret.ciphertext, existingSecret.id),
                );
                if (value && typeof value === "object" && !Array.isArray(value))
                  existingMaterial = value as Record<string, unknown>;
              } catch {
                /* Existing malformed secrets are replaced only when new credentials are supplied. */
              }
            }
            const config =
              "config" in input
                ? input.config
                : {
                    slug: existing.slug,
                    name: existing.name,
                    description: existing.description,
                    enabled: existing.enabled,
                    verbatimResults: existing.verbatimResults,
                    transport: existing.transport as "streamable_http" | "sse",
                    endpoint: existing.endpoint!,
                    headers: (existingMaterial.headers ?? {}) as Record<string, string>,
                    secret: input.secret,
                  };
            if (!("config" in input) && existing.transport === "stdio") {
              throw new ORPCError("BAD_REQUEST", { message: "A remote MCP server is required" });
            }
            const nextEndpoint = "endpoint" in config ? config.endpoint : null;
            if (existing.endpoint !== nextEndpoint) {
              await assertMcpRemoteEndpoint(nextEndpoint, deps);
            }
            if (config.transport === "stdio") {
              await assertMcpStdioCommand(config.command, context.actor, deps);
              await assertMcpRemoteEndpoint(config.oauthClient?.authorizationServer, deps);
            } else if (existing.transport === "stdio") {
              await assertMcpStdioAdmin(context.actor, deps);
            }
            const endpointChanged = existing.endpoint !== nextEndpoint;
            existingMaterial.args ??= legacyMcpArgs(existing.args);
            const update = buildMcpUpdateMaterial(existingMaterial, config, {
              clearOAuth: endpointChanged,
              endpointChanged,
              commandChanged: existing.command !== ("command" in config ? config.command : null),
            });
            if (update.action === "store" && config.transport === "stdio") {
              await assertMcpRemoteEndpoint(
                update.material.oauthClient?.authorization_server,
                deps,
              );
              assertMcpOAuthTemplates(
                update.material.env ?? {},
                update.material.files ?? {},
                Boolean(update.material.oauthClient),
              );
            }
            const stored =
              update.action === "store" && Object.keys(update.material).length > 0
                ? await deps.secrets.put(
                    JSON.stringify(update.material),
                    computerContext(context.actor, "mcp", "mcp.update"),
                  )
                : null;
            const clearing = update.action === "store" && Object.keys(update.material).length === 0;
            const row = await persistPreparedSecret(
              deps.prisma,
              deps.secrets,
              stored ?? undefined,
              () =>
                deps.prisma.$transaction(async (tx) => {
                  // A rename claims a name; availability changes take that lock before the secret,
                  // so this takes it first too and the two can never wait on each other.
                  if (config.slug !== existing.slug)
                    await lockOwner(tx, context.actor.userId, "names:mcpServer");
                  await lockMcpOAuthMaterial(tx, input.id);
                  const current = await tx.mcpServer.findFirst({
                    where: {
                      id: input.id,
                      ...availableInSpace(context.actor),
                    },
                  });
                  if (!current) throw new IsolationError();
                  if (
                    current.revision !== existing.revision ||
                    current.secretId !== existing.secretId ||
                    current.endpoint !== existing.endpoint
                  )
                    return null;
                  if (current.secretId)
                    await tx.$queryRaw`SELECT id FROM secrets WHERE id = ${current.secretId} FOR UPDATE`;
                  const secret = current.secretId
                    ? await tx.secret.findFirst({
                        where: {
                          id: current.secretId,
                          ...itemSecretIn(context.actor),
                        },
                      })
                    : null;
                  if (secret?.ciphertext !== existingSecret?.ciphertext) return null;
                  if (config.slug !== current.slug)
                    await assertNameFreeWhereAvailable(
                      tx,
                      "mcpServer",
                      context.actor,
                      config.slug,
                      await serverAvailability(tx, current),
                      current.id,
                    );
                  if (stored) {
                    await tx.secret.create({
                      data: {
                        id: stored.id,
                        userId: context.actor.userId,
                        spaceId: await serverSecretSpace(tx, current),
                        kind: "mcp",
                        ciphertext: stored.ciphertext,
                      },
                    });
                  }
                  const updated = await tx.mcpServer.update({
                    where: { id: existing.id },
                    data: {
                      slug: config.slug,
                      name: config.name,
                      description: config.description,
                      transport: config.transport,
                      endpoint: nextEndpoint,
                      command: "command" in config ? config.command : null,
                      args: [],
                      hasArgs: update.action === "store" && Boolean(update.material.args?.length),
                      env: ("env" in config
                        ? Object.fromEntries(Object.keys(config.env).map((key) => [key, true]))
                        : {}) as Prisma.InputJsonValue,
                      // Omitted files are kept in the material, so the keys follow it.
                      ...(update.action === "store"
                        ? {
                            files: Object.fromEntries(
                              Object.keys(update.material.files ?? {}).map((key) => [key, true]),
                            ) as Prisma.InputJsonValue,
                          }
                        : {}),
                      headers: ("headers" in config
                        ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, true]))
                        : {}) as Prisma.InputJsonValue,
                      enabled: config.enabled,
                      verbatimResults: config.verbatimResults,
                      revision: { increment: 1 },
                      // The old verdict is about the old config.
                      healthStatus: "unknown",
                      healthMessage: null,
                      healthToolCount: null,
                      healthCheckedAt: null,
                      ...(stored ? { secretId: stored.id } : clearing ? { secretId: null } : {}),
                    },
                  });
                  if ((stored || clearing) && existing.secretId)
                    await tx.secret.deleteMany({
                      where: {
                        id: existing.secretId,
                        ...itemSecretIn(context.actor),
                      },
                    });
                  return updated;
                }),
            );
            if (row) {
              const oauth = await mcpOAuth.summaryFor(row, context.actor);
              return mcpServerDto(await beginMcpProbe(row, context.actor, oauth), oauth);
            }
          }
          throw new ORPCError("CONFLICT", { message: "MCP credentials changed; retry" });
        }),
        test: authed.mcp.servers.test.handler(async ({ context, input }) => {
          const scope = { id: input.id, ...availableInSpace(context.actor) };
          const server = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!server) throw new IsolationError();
          const oauth = await mcpOAuth.summaryFor(server, context.actor);
          if (!deps.mcp) {
            await recordMcpServerHealth(
              deps.prisma,
              server.id,
              { status: "error", message: "This server cannot be checked from here." },
              server.revision,
            );
          } else if (await mcpAwaitsOAuth(server, context.actor, oauth)) {
            await recordMcpServerHealth(
              deps.prisma,
              server.id,
              { status: "unknown", message: MCP_OAUTH_PENDING_MESSAGE },
              server.revision,
            );
          } else {
            await probeMcpServer(server, context.actor);
          }
          const fresh = await deps.prisma.mcpServer.findFirst({ where: scope });
          if (!fresh) throw new IsolationError();
          return mcpServerDto(fresh, oauth);
        }),
        agents: authed.mcp.servers.agents.handler(async ({ context, input }) => {
          const owner = { spaceId: context.actor.spaceId, userId: context.actor.userId };
          const { server, assignments, seqs } = await deps.prisma.$transaction(async (tx) => {
            const existing = await tx.mcpServer.findFirst({
              where: { id: input.id, ...availableInSpace(context.actor) },
              select: { id: true },
            });
            if (!existing) throw new IsolationError();
            const server = await tx.mcpServer.update({
              where: { id: existing.id },
              data: { allBots: input.allBots },
              include: { availableIn: AVAILABILITY_SELECT },
            });
            let seqs: Array<{ threadId: string; seq: number }> = [];
            // Under allBots the assignments stay as they were, so choosing agents again restores them.
            if (!input.allBots) {
              const botIds = [...new Set(input.botIds)];
              const bots = await tx.bot.findMany({
                where: { ...owner, id: { in: botIds } },
                select: { id: true },
              });
              if (bots.length !== botIds.length) throw new IsolationError();
              const previous = await tx.botMcpServer.findMany({
                where: { ...owner, serverId: server.id },
                select: { botId: true },
              });
              const removed = previous
                .map((row) => row.botId)
                .filter((botId) => !botIds.includes(botId));
              await tx.botMcpServer.deleteMany({
                where: { ...owner, serverId: server.id, botId: { in: removed } },
              });
              await tx.botMcpServer.createMany({
                data: botIds.map((botId) => ({ ...owner, botId, serverId: server.id })),
                skipDuplicates: true,
              });
              seqs = (
                await Promise.all(
                  removed.map((botId) =>
                    revertConnectedMcpApprovals(
                      onboardingDeps,
                      context.actor,
                      { botId, serverId: server.id, status: "pending" },
                      tx,
                    ),
                  ),
                )
              ).flat();
            }
            const assignments = await tx.botMcpServer.findMany({
              where: { ...owner, serverId: server.id },
              orderBy: { createdAt: "asc" },
            });
            return { server, assignments, seqs };
          });
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          const oauth = await mcpOAuth.summaryFor(server, context.actor);
          return {
            server: mcpServerDto(server, oauth),
            assignments: assignments.map(mcpAssignmentDto),
          };
        }),
        remove: authed.mcp.servers.remove.handler(async ({ context, input }) => {
          const server = await deps.prisma.mcpServer.findFirst({
            where: {
              id: input.id,
              ...availableInSpace(context.actor),
            },
            select: { id: true, secretId: true },
          });
          if (!server) throw new IsolationError();
          // Assignments cascade; the encrypted credential must go with the server.
          // Cards are closed first, including ones that were never assigned.
          const seqs = await deps.prisma.$transaction((tx) =>
            removeMcpServerInTransaction(tx, context.actor, server),
          );
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          return { ok: true as const };
        }),
      },
      // Any bot in the space can use the member's own servers; servers and assignments stay personal.
      assignments: {
        all: authed.mcp.assignments.all.handler(async ({ context }) => {
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              bot: { archivedAt: null },
              server: availableInSpace(context.actor),
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        list: authed.mcp.assignments.list.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
            },
            select: { id: true },
          });
          if (!bot) throw new IsolationError();
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              botId: bot.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              server: availableInSpace(context.actor),
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        approve: authed.mcp.assignments.approve.handler(async ({ context, input }) => {
          const row = await resolveMcpApprovalCards(
            onboardingDeps,
            context.actor,
            {
              botId: input.botId,
              serverId: input.serverId,
              status: "connected",
              threadId: input.threadId,
            },
            async (tx, decision) => {
              if (!decision.assign) throw new IsolationError();
              const [bot, server] = await Promise.all([
                tx.bot.findFirst({
                  where: {
                    id: input.botId,
                    spaceId: context.actor.spaceId,
                  },
                  select: { id: true },
                }),
                tx.mcpServer.findFirst({
                  where: {
                    id: input.serverId,
                    ...availableInSpace(context.actor),
                    enabled: true,
                  },
                  select: { id: true },
                }),
              ]);
              if (!bot || !server) throw new IsolationError();
              const assignment = await tx.botMcpServer.upsert({
                where: { botId_serverId: { botId: bot.id, serverId: server.id } },
                create: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: server.id,
                  allowAllTools: true,
                  allowedTools: [],
                },
                update: {},
              });
              const runId =
                input.threadId && decision.resolved
                  ? await queueMcpConnectedRun(tx, context.actor, {
                      botId: bot.id,
                      serverId: server.id,
                      threadId: input.threadId,
                    })
                  : null;
              return { assignment, runId };
            },
          );
          if (!row) throw new IsolationError();
          if (row.runId) {
            // The queued run is durable; a missed wake is repaired by the reconciler.
            await deps.jobs.enqueue(runContinueJob(row.runId)).catch((error) => {
              getLogger().error("mcp connected enqueue", error);
            });
          }
          return mcpAssignmentDto(row.assignment);
        }),
        dismiss: authed.mcp.assignments.dismiss.handler(async ({ context, input }) => {
          // Not now resolves the card only. Assignments are never touched
          // here: a stale card must not delete a live connection, and server
          // removal belongs to the MCP settings surface.
          await resolveMcpApprovalCards(onboardingDeps, context.actor, {
            botId: input.botId,
            serverId: input.serverId,
            status: "dismissed",
            threadId: input.threadId,
          });
          return { ok: true as const };
        }),
        replace: authed.mcp.assignments.replace.handler(async ({ context, input }) => {
          const { rows, seqs } = await deps.prisma.$transaction(async (tx) => {
            const bot = await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: context.actor.spaceId,
              },
              select: { id: true },
            });
            if (!bot) throw new IsolationError();
            const servers = await tx.mcpServer.findMany({
              where: {
                id: { in: input.assignments.map((assignment) => assignment.serverId) },
                ...availableInSpace(context.actor),
              },
              select: { id: true },
            });
            if (servers.length !== input.assignments.length) throw new IsolationError();
            const previous = await tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { serverId: true },
            });
            const nextIds = new Set(input.assignments.map((assignment) => assignment.serverId));
            const removed = previous
              .map((row) => row.serverId)
              .filter((serverId) => !nextIds.has(serverId));
            await tx.botMcpServer.deleteMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (input.assignments.length)
              await tx.botMcpServer.createMany({
                data: input.assignments.map((assignment) => ({
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: assignment.serverId,
                  allowAllTools: assignment.allowAllTools,
                  allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
                })),
              });
            const seqs = (
              await Promise.all(
                removed.map((serverId) =>
                  revertConnectedMcpApprovals(
                    onboardingDeps,
                    context.actor,
                    { botId: bot.id, serverId, status: "pending" },
                    tx,
                  ),
                ),
              )
            ).flat();
            const rows = await tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              orderBy: { createdAt: "asc" },
            });
            return { rows, seqs };
          });
          for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
          return rows.map(mcpAssignmentDto);
        }),
      },
      oauth: {
        begin: authed.mcp.oauth.begin.handler(async ({ context, input }) => {
          try {
            const expectedRedirect = new URL("/mcp/oauth/callback", deps.env.webOrigin).toString();
            // Native clients omit the redirect; the registered web callback is always used.
            if (input.redirectUri && new URL(input.redirectUri).toString() !== expectedRedirect) {
              throw new ORPCError(MCP_OAUTH_REDIRECT_MISMATCH, {
                status: 400,
                message: "The sign-in address does not match this server's configuration.",
              });
            }
            return await mcpOAuth.begin({
              ...input,
              redirectUri: expectedRedirect,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
          } catch (error) {
            if (error instanceof ORPCError) throw error;
            if (error instanceof McpOAuthClientRequiredError) {
              await recordMcpServerHealth(
                deps.prisma,
                input.serverId,
                { status: "error", message: error.message },
                error.revision,
              );
              throw new ORPCError(error.code, { status: 400, message: error.message });
            }
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not start MCP OAuth",
            });
          }
        }),
        complete: authed.mcp.oauth.complete.handler(async ({ context, input }) => {
          try {
            const { serverId, revision } = await mcpOAuth.complete({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
            // A check from before the sign-in would otherwise still read as failing. Only this
            // sign-in's revision: an edit since then has its own health and its own check.
            await recordMcpServerHealth(
              deps.prisma,
              serverId,
              { status: "unknown", message: null },
              revision,
            );
            // The account is connected now: check the server so it shows ok/error.
            void (async () => {
              const server = await deps.prisma.mcpServer.findFirst({
                where: { id: serverId, revision, ...availableInSpace(context.actor) },
              });
              if (server)
                await beginMcpProbe(
                  server,
                  context.actor,
                  await mcpOAuth.summaryFor(server, context.actor),
                );
            })().catch((error) => getLogger().error("mcp server probe after oauth failed", error));
            return { ok: true as const };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not complete MCP OAuth",
            });
          }
        }),
        disconnect: authed.mcp.oauth.disconnect.handler(async ({ context, input }) => {
          const revision = await mcpOAuth.disconnect({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          // A health check from before the disconnect would otherwise still read as connected.
          // Only this disconnect's revision: a sign-in since then has its own health.
          if (revision !== undefined)
            await recordMcpServerHealth(
              deps.prisma,
              input.serverId,
              { status: "unknown", message: MCP_OAUTH_PENDING_MESSAGE },
              revision,
            );
          return { ok: true as const };
        }),
      },
    },
  };
}
