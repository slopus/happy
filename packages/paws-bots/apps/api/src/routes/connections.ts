import type { ConnectorCatalogItem } from "@rakazo/adapter-kit";
import { planLiveConnectionSync } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError, recordSecurityEvent } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  beginConnection,
  completeConnection,
  connectionContext,
  revokeConnection,
} from "../connection-flows.js";
import { connectionCreatedEvent } from "../security-audit.js";
import type { RouterContext } from "./context.js";

async function reconcileConnections(
  prisma: PrismaClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  connectedProviders: string[],
  reconnectRefs: string[],
): Promise<void> {
  const connectedProviderKeys = new Set(
    connectedProviders.map((provider) => provider.trim().toLowerCase()),
  );
  const rows = (
    await prisma.connection.findMany({
      where: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId,
        status: { in: ["pending", "connected"] },
      },
      select: { id: true, provider: true, displayName: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter((row: { provider: string }) =>
    connectedProviderKeys.has(row.provider.trim().toLowerCase()),
  );
  const sync = planLiveConnectionSync(rows, connectedProviders);
  // One update per row so the credential event goes only to rows this call actually connected.
  const connectedIds: string[] = [];
  const updates = [
    ...sync.connectIds.map((id) => async (tx: Prisma.TransactionClient) => {
      const updated = await tx.connection.updateMany({
        where: { id, spaceId: owner.spaceId, userId: owner.userId, status: "pending" },
        data: { status: "connected" },
      });
      if (updated.count > 0) connectedIds.push(id);
    }),
    ...(sync.revokeIds.length > 0
      ? [
          (tx: Prisma.TransactionClient) =>
            tx.connection.updateMany({
              where: {
                id: { in: sync.revokeIds },
                spaceId: owner.spaceId,
                userId: owner.userId,
                status: "pending",
              },
              data: { status: "revoked" },
            }),
        ]
      : []),
    // The provider reports these accounts dead, so the app offers to connect them again.
    ...(reconnectRefs.length > 0
      ? [
          (tx: Prisma.TransactionClient) =>
            tx.connection.updateMany({
              where: {
                spaceId: owner.spaceId,
                userId: owner.userId,
                connectorId,
                status: "connected",
                providerRef: { in: reconnectRefs },
              },
              data: { status: "error" },
            }),
        ]
      : []),
  ];
  // Interactive rather than a batch: a batch cannot carry the request's database context.
  if (updates.length > 0)
    await prisma.$transaction(async (tx) => {
      for (const update of updates) await update(tx);
    });
  for (const id of connectedIds) {
    await recordSecurityEvent(connectionCreatedEvent("connections.catalog", id, owner));
  }
}

/** Serialize begin/revoke for one user+provider so slug-wide remote deletes cannot race a new connect. */

export function connectionsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        const adapterContext = connectionContext(
          context.actor,
          "connections.catalog",
          context.signal,
        );
        const providers = input.connectorId
          ? [deps.connectors.managed(input.connectorId)].filter(
              (provider): provider is NonNullable<typeof provider> => Boolean(provider),
            )
          : deps.connectors.managedProviders();
        const catalogs = await Promise.all(
          providers.map(async (provider): Promise<ConnectorCatalogItem[]> => {
            try {
              const [items, reconnectRefs] = await Promise.all([
                provider.catalog(adapterContext, input.query),
                provider.listReconnectRefs?.(adapterContext).catch(() => []) ?? [],
              ]);
              const nowConnected = items.filter((item) => item.connected).map((item) => item.slug);
              if (nowConnected.length > 0 || reconnectRefs.length > 0) {
                await reconcileConnections(
                  deps.prisma,
                  context.actor,
                  provider.describe().id,
                  nowConnected,
                  reconnectRefs,
                ).catch((error) => {
                  getLogger().error(
                    `${provider.describe().id} connection reconciliation failed`,
                    error,
                  );
                });
              }
              return items;
            } catch {
              return [];
            }
          }),
        );
        return catalogs.flat();
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.connection.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      begin: authed.connections.begin.handler(({ context, input }) =>
        beginConnection(deps, context, input),
      ),
      complete: authed.connections.complete.handler(({ context, input }) =>
        completeConnection(deps, context, input),
      ),
      rename: authed.connections.rename.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const row = await deps.prisma.connection.update({
          where: { id: existing.id },
          data: { displayName: input.displayName },
        });
        return {
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      revoke: authed.connections.revoke.handler(({ context, input }) =>
        revokeConnection(deps, context, input),
      ),
      tools: authed.connections.tools.handler(async ({ context, input }) => {
        const connector = deps.connectors.managed(input.connectorId);
        if (!connector) return [];
        const row = await deps.prisma.connection.findFirst({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: input.connectorId,
            provider: input.provider,
            status: "connected",
          },
        });
        if (!row) return [];
        try {
          const adapterContext = {
            ...connectionContext(context.actor, "connections.tools", context.signal),
            connectedConnections: [
              {
                id: row.id,
                connectorId: input.connectorId,
                externalId: input.provider,
                displayName: row.displayName,
                providerRef: row.providerRef ?? undefined,
              },
            ],
            connectedProviders: [input.provider],
          };
          const tools = connector.listAppTools
            ? await connector.listAppTools(adapterContext, input.provider)
            : await connector.discoverTools(adapterContext);
          return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          }));
        } catch (error) {
          getLogger().error("connections.tools failed", error, {
            connectorId: input.connectorId,
            provider: input.provider,
          });
          return [];
        }
      }),
    },
  };
}
