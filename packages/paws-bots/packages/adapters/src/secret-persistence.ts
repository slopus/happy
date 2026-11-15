import { AsyncLocalStorage } from "node:async_hooks";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { deleteSecretBestEffort } from "./secret-store-factory.js";

type Candidate = { id: string; ciphertext: string };
type Cleanup = { old: Candidate[]; written: Candidate[]; client?: Prisma.TransactionClient };
// A ciphertext ref can be shared across tenants, so the reference count must see
// every row: deleting from the store on a tenant-filtered count of zero would
// destroy a secret another Space still uses.
function cleanupUnreferenced(
  prisma: PrismaClient,
  store: SecretStore,
  candidates: Candidate[],
): Promise<void> {
  return runAsSystem("secret reference count", () => deleteUnreferenced(prisma, store, candidates));
}

async function deleteUnreferenced(
  prisma: PrismaClient,
  store: SecretStore,
  candidates: Candidate[],
): Promise<void> {
  for (const row of new Map(candidates.map((row) => [row.ciphertext, row])).values()) {
    try {
      if (
        (await prisma.secret.count({ where: { ciphertext: row.ciphertext } })) ||
        (await prisma.botSecret.count({ where: { ciphertext: row.ciphertext } })) ||
        (await prisma.vaultCredential.count({ where: { ciphertext: row.ciphertext } })) ||
        (await prisma.integrationProviderConfig.count({
          where: { ciphertext: row.ciphertext },
        }))
      )
        continue;
      await deleteSecretBestEffort(store, row.ciphertext, row.id);
    } catch {
      getLogger().warn("Secret cleanup failed; retry cleanup before removing provider access");
    }
  }
}

// Prepared writes exist before the transaction starts. Defer its cleanup until
// the writer has adopted the committed ref (notably a live OAuth session).
const preparedWrite = new AsyncLocalStorage<{ cleanup: Array<() => Promise<void>> }>();
export async function persistPreparedSecret<T>(
  prisma: PrismaClient,
  store: SecretStore,
  written: Candidate | undefined,
  commit: () => Promise<T>,
  adopted?: (result: T) => void,
): Promise<T> {
  const state = { cleanup: [] as Array<() => Promise<void>> };
  try {
    const result = await preparedWrite.run(state, commit);
    adopted?.(result);
    return result;
  } finally {
    for (const cleanup of state.cleanup) await cleanup();
    if (written) await cleanupUnreferenced(prisma, store, [written]);
  }
}

type Mutation = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Array<Record<string, unknown>>;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};
const secretTables = {
  Secret: "secrets",
  BotSecret: "bot_secrets",
  VaultCredential: "vault_credentials",
  IntegrationProviderConfig: "integration_provider_configs",
};
const parentTables = { User: "user", Space: "spaces", Bot: "bots", Organization: "organization" };

/** Cleanup is coordinated with the DB transaction, including parent cascades.
 * Credential mutations use interactive transactions; unrelated batch operations
 * retain their native behavior. Inline encrypted refs still notify consumers. */
export function withSecretPersistence(prisma: PrismaClient, store: SecretStore): PrismaClient {
  const transaction = new AsyncLocalStorage<Cleanup>();
  async function cleanup(candidates: Candidate[]): Promise<void> {
    const prepared = preparedWrite.getStore();
    if (prepared) {
      prepared.cleanup.push(() => cleanupUnreferenced(prisma, store, candidates));
      return;
    }
    await cleanupUnreferenced(prisma, store, candidates);
  }
  async function lockedRows(
    state: Cleanup,
    model: string,
    where?: Record<string, unknown>,
  ): Promise<Candidate[]> {
    const client = state.client!;
    const delegateName = model[0]!.toLowerCase() + model.slice(1);
    const delegate = Reflect.get(client, delegateName);
    const rows = (await Reflect.apply(delegate.findMany, delegate, [
      { where, select: { id: true } },
    ])) as Array<{ id: string }>;
    if (!rows.length) return [];
    const table =
      secretTables[model as keyof typeof secretTables] ??
      parentTables[model as keyof typeof parentTables];
    // Static table allowlist; values remain bound parameters. Locks capture the actual
    // replaced ref even if another writer committed between selection and the lock.
    const fields = model in secretTables ? Prisma.raw("id, ciphertext") : Prisma.raw("id");
    return client.$queryRaw<Candidate[]>(
      Prisma.sql`SELECT ${fields} FROM ${Prisma.raw(`"${table}"`)} WHERE id IN (${Prisma.join(rows.map((row) => row.id))}) ORDER BY id FOR UPDATE`,
    );
  }
  function trackWrites(state: Cleanup, model: string, input: Mutation): void {
    if (!(model in secretTables)) return;
    // Track new writes before DB access so even a pre-read failure can clean them.
    const data = [
      ...(Array.isArray(input.data) ? input.data : [input.data]),
      input.create,
      input.update,
    ];
    for (const value of data)
      if (typeof value?.ciphertext === "string") {
        const id = String(value.id ?? input.where?.id ?? "secret");
        state.written.push({
          id: model === "IntegrationProviderConfig" ? `integration-provider:${id}` : id,
          ciphertext: value.ciphertext,
        });
      }
  }
  async function prepare(
    state: Cleanup,
    model: string,
    operation: string,
    input: Mutation,
  ): Promise<void> {
    if (model in secretTables) {
      trackWrites(state, model, input);
      if (!operation.startsWith("create")) {
        const old = await lockedRows(state, model, input.where);
        state.old.push(
          ...old.map((row) =>
            model === "IntegrationProviderConfig"
              ? { ...row, id: `integration-provider:${row.id}` }
              : row,
          ),
        );
      }
      return;
    }
    const parents = await lockedRows(state, model, input.where);
    let filter: Record<string, unknown> = {
      [model === "User" ? "userId" : model === "Space" ? "spaceId" : "botId"]: {
        in: parents.map((row) => row.id),
      },
    };
    if (model === "Organization") {
      const spaces = await lockedRows(state, "Space", {
        organizationId: { in: parents.map((row) => row.id) },
      });
      filter = { spaceId: { in: spaces.map((row) => row.id) } };
    }
    if (model !== "Bot") {
      state.old.push(...(await lockedRows(state, "Secret", filter)));
      state.old.push(...(await lockedRows(state, "VaultCredential", filter)));
    }
    state.old.push(...(await lockedRows(state, "BotSecret", filter)));
  }
  const extended = prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const relevant =
            (model in secretTables &&
              [
                "delete",
                "deleteMany",
                "update",
                "updateMany",
                "upsert",
                "create",
                "createMany",
              ].includes(operation)) ||
            (model in parentTables && ["delete", "deleteMany"].includes(operation));
          if (!relevant) return query(args);
          const active = transaction.getStore();
          if (active && !active.client) {
            trackWrites(active, model, args as Mutation);
            // A batch exposes no transaction client for locking and capture.
            // Fail before changing refs rather than break batch atomicity.
            throw new Error("Use an interactive transaction for secret persistence");
          }
          if (active?.client) {
            await prepare(active, model, operation, args as Mutation);
            return query(args);
          }
          const state: Cleanup = { old: [], written: [] };
          try {
            // Standalone mutations also need a transaction, so capture and replacement
            // share the same connection and row locks. No extra pool slot inside a tx.
            const result = await prisma.$transaction((tx) =>
              transaction.run(state, async () => {
                state.client = tx;
                await prepare(state, model, operation, args as Mutation);
                const delegate = Reflect.get(tx, model[0]!.toLowerCase() + model.slice(1));
                return Reflect.apply(delegate[operation], delegate, [args]);
              }),
            );
            await cleanup([...state.old, ...state.written]);
            return result;
          } catch (error) {
            await cleanup(state.written);
            throw error;
          }
        },
      },
    },
  });
  return new Proxy(extended, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        const callback =
          typeof args[0] === "function"
            ? (args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>)
            : undefined;
        const state: Cleanup = { old: [], written: [] };
        if (callback)
          args[0] = (tx: Prisma.TransactionClient) => {
            state.client = tx;
            return callback(tx);
          };
        try {
          const result = await transaction.run(state, () =>
            Reflect.apply(target.$transaction, target, args),
          );
          await cleanup([...state.old, ...state.written]);
          return result;
        } catch (error) {
          await cleanup(state.written);
          throw error;
        }
      };
    },
  }) as unknown as PrismaClient;
}
