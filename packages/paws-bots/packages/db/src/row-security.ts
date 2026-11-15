import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import type { Pool, PoolClient } from "pg";
import type { PrismaClient } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";
import { withTransactionRetry } from "./transaction-retry.js";

/**
 * Who a database operation runs for. Row-level security policies read the
 * matching `app.*` settings on the connection that runs the statement.
 *
 * - `tenant`: rows are limited to one Space (and, for user-owned rows, one user).
 * - `system`: an explicit, named bypass for work that legitimately spans
 *   tenants (job dispatch, reconcilers, webhooks before they resolve a tenant).
 *
 * Without a context, protected tables return no rows and reject writes.
 */
export type DbContext =
  | { kind: "tenant"; spaceId: string; userId: string }
  | { kind: "system"; reason: string };

const storage = new AsyncLocalStorage<DbContext>();

export function currentDbContext(): DbContext | undefined {
  return storage.getStore();
}

export function runAsTenant<T>(
  tenant: { spaceId: string; userId: string },
  fn: () => T | PromiseLike<T>,
): Promise<T> {
  return within({ kind: "tenant", spaceId: tenant.spaceId, userId: tenant.userId }, fn);
}

/**
 * Run `fn` across tenants. Each call is an audited bypass of row-level
 * security, so name why: `grep -rn "runAsSystem("` lists every one.
 */
export function runAsSystem<T>(reason: string, fn: () => T | PromiseLike<T>): Promise<T> {
  return within({ kind: "system", reason }, fn);
}

/**
 * The same client with every call run as an explicit system context, for test
 * fixtures and assertions that have no request or job around them. Code under
 * test keeps the context its request or job gives it.
 */
export function asSystem<T extends object>(client: T, reason = "test fixture"): T {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key);
      // A synchronous accessor that reads no rows; wrapping it would hand back a promise.
      if (key === "$contentEncryption") return value;
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          runAsSystem(reason, () => Reflect.apply(value, target, args));
      }
      if (value && typeof value === "object") return asSystem(value, reason);
      return value;
    },
  });
}

type SqlClient = Pick<PrismaClient, "$queryRaw">;

/**
 * runAsSystem for a step inside an interactive transaction a tenant opened: the
 * transaction's connection keeps the settings it was checked out with, so this
 * turns the bypass on for `fn` and back afterwards. Name why, as for runAsSystem.
 */
export async function runAsSystemInTransaction<T>(
  tx: SqlClient,
  reason: string,
  fn: () => Promise<T>,
): Promise<T> {
  const [previous] = await tx.$queryRaw<
    Array<{ bypass: string | null; key: string | null; login: string }>
  >`SELECT current_setting('app.rls_bypass', true) AS bypass,
      current_setting('app.rls_bypass_key', true) AS key, session_user AS login`;
  const restore = () =>
    tx.$queryRaw`SELECT set_config('app.rls_bypass', ${previous?.bypass ?? "off"}, true),
      set_config('app.rls_bypass_key', ${previous?.key ?? ""}, true)`;
  await tx.$queryRaw`SELECT set_config('app.rls_bypass', 'on', true),
    set_config('app.rls_bypass_key', ${bypassKeys.get(previous?.login ?? "") ?? ""}, true)`;
  let result: T;
  try {
    result = await within({ kind: "system", reason }, fn);
  } catch (error) {
    // A failed statement aborts the transaction, which drops the local setting anyway.
    await restore().catch(() => undefined);
    throw error;
  }
  await restore();
  return result;
}

// Prisma operations are lazy and start when awaited. Await inside the scope so
// an operation returned from `fn` still runs with this context.
function within<T>(context: DbContext, fn: () => T | PromiseLike<T>): Promise<T> {
  return storage.run(context, async () => await fn());
}

export const ROW_SECURITY_MODELS: ReadonlySet<string> = new Set([
  "BillingAuditEvent",
  "PushToken",
  "CallPushDevice",
  "WorkActivityToken",
  "WorkActivityStartToken",
  "EmailSend",
  "Thread",
  "ThreadRead",
  "Message",
  "Event",
  "MemoryDocument",
  "MemoryRevision",
  "Artifact",
  "Secret",
  "BotSecret",
  "VaultCredential",
  "VaultCredentialBot",
  "VaultCredentialLimit",
  "AgentSecret",
  "UserModelCredential",
  "UserVoiceCredential",
  "TrustedLinkSite",
  "FeedbackReport",
  "PaymentWallet",
  "Purchase",
  "SpendingLimit",
  "Payment",
  "TaughtSkill",
  "AgentSkill",
  "AgentSkillSpace",
  "CapabilityInstallSpace",
  "AgentImport",
  "Bot",
  "Run",
  "Task",
  "Routine",
  "Connection",
  "McpServer",
  "McpServerSpace",
  "McpOAuthSession",
  "ModelOAuthSession",
  "BotMcpServer",
  "Computer",
  "ComputerRun",
  "HomeDeletionNotice",
  "Board",
  "Ticket",
  "TicketComment",
  "MessagingIdentity",
  "MessagingInstallation",
  "MessagingInstallSession",
  "MessagingOutbound",
  "ExternalConversation",
  "ExternalMessage",
  "SteeringMessage",
  "UsageRecord",
  "ScratchpadItem",
  "BotEmailMessage",
  "BotEmailSend",
  "ActionApprovalRule",
  "SpaceModelRoleChoice",
  "SpaceSettingOverride",
  "UserModelRoleChoice",
  "UserModelPreference",
  "UserVoicePreference",
  "UserActionApprovalRule",
  "UserActionAutoReviewPreference",
  "SecurityEvent",
  "AuditEvent",
  "Page",
  "PageVersion",
]);

/**
 * Proves a system context to the database. The policies honour app.rls_bypass only
 * alongside this key, whose digest `pnpm db:migrate` stores where the runtime role
 * cannot read it, so SQL that runs for a tenant cannot turn the bypass on itself.
 * Derived from the runtime login's password, so it needs no setting of its own.
 */
export function rlsBypassKey(connectionString: string | undefined): string {
  const { password } = credentials(connectionString);
  return password ? createHmac("sha256", password).update("rakazo rls bypass").digest("hex") : "";
}

// As pg-connection-string reads them: query parameters win over the URL's userinfo, and a
// stray `%` is escaped first.
function credentials(connectionString: string | undefined): { user: string; password: string } {
  let normalized = connectionString ?? "";
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(normalized))
    normalized = encodeURI(normalized).replace(/%25(\d\d)/g, "%$1");
  try {
    const url = new URL(normalized);
    return {
      user: url.searchParams.get("user") || decodeURIComponent(url.username),
      password: url.searchParams.get("password") || decodeURIComponent(url.password),
    };
  } catch {
    return { user: "", password: "" };
  }
}

// By login, for runAsSystemInTransaction, which only has the transaction's connection.
const bypassKeys = new Map<string, string>();

type Settings = [spaceId: string, userId: string, bypass: "on" | "off", bypassKey: string];

function settingsFor(context: DbContext | undefined, bypassKey: string): Settings {
  if (context?.kind === "tenant") return [context.spaceId, context.userId, "off", ""];
  if (context?.kind === "system") return ["", "", "on", bypassKey];
  return ["", "", "off", ""];
}

const SET_SESSION =
  "SELECT set_config('app.space_id', $1, false), set_config('app.user_id', $2, false), set_config('app.rls_bypass', $3, false), set_config('app.rls_bypass_key', $4, false), set_config('app.vault_access_version', '1', false)";
const applied = new WeakMap<PoolClient, string>();

async function applySettings(client: PoolClient, settings: Settings): Promise<void> {
  const key = settings.join("\u0000");
  // A new connection has none of the settings yet, the version included.
  if (applied.get(client) === key) return;
  // Forget the old value first: if this fails, the next checkout sets it again.
  applied.delete(client);
  await client.query(SET_SESSION, settings);
  applied.set(client, key);
}

/**
 * Give every connection checked out of `pool` the settings of the context that
 * asked for it, captured when `connect` is called (the callback of a queued
 * checkout can run in whichever request released the connection). A
 * connection only gets a round trip when its settings change, and a checkout
 * with no context clears what an earlier one left behind.
 */
export function installDbContext(pool: Pool): void {
  const { connectionString } = pool.options;
  const bypassKey = rlsBypassKey(connectionString);
  if (bypassKey) bypassKeys.set(credentials(connectionString).user, bypassKey);
  type ConnectCallback = (
    err: Error | undefined,
    client: PoolClient | undefined,
    done: (release?: unknown) => void,
  ) => void;
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };

  function connect(): Promise<PoolClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    const settings = settingsFor(storage.getStore(), bypassKey);
    if (!callback) {
      return originalConnect().then(async (client) => {
        try {
          await applySettings(client, settings);
          return client;
        } catch (error) {
          client.release(error as Error);
          throw error;
        }
      });
    }
    originalConnect((err, client, done) => {
      if (err || !client) return callback(err, client, done);
      applySettings(client, settings).then(
        () => callback(undefined, client, done),
        (error: Error) => {
          done(error);
          callback(error, undefined, () => undefined);
        },
      );
    });
  }

  pool.connect = connect as Pool["connect"];
}

const LOCAL_SETTINGS = (settings: Settings) =>
  Prisma.sql`SELECT set_config('app.space_id', ${settings[0]}, true), set_config('app.user_id', ${settings[1]}, true), set_config('app.rls_bypass', ${settings[2]}, true), set_config('app.rls_bypass_key', ${settings[3]}, true), set_config('app.vault_access_version', '1', true)`;

// A wrapped read keeps the pool's checkout timeout and no run limit it did not
// have before, instead of Prisma's 2s/5s transaction defaults.
export const WRAPPED_OPERATION_OPTIONS = { maxWait: 10_000, timeout: 300_000 };

type InternalParams = { transaction?: { kind?: string }; dataPath?: unknown[] };
type RuntimeDataModel = { models: Record<string, { fields: Array<{ name: string }> }> };
type Where = Record<string, unknown>;

const LOGICAL = new Set(["AND", "OR", "NOT"]);

/**
 * The same filter as a findUnique `where`, for findFirst: compound unique keys
 * (`spaceId_name: { spaceId, name }`) become their fields. Undefined when the
 * shape is not recognised.
 */
function uniqueAsFilter(where: Where, fields: Set<string>): Where | undefined {
  const filter: Where = {};
  const compounds: Where[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (fields.has(key) || LOGICAL.has(key)) filter[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value))
      compounds.push(value as Where);
    else return undefined;
  }
  if (!compounds.length) return filter;
  const and = filter.AND === undefined ? [] : Array.isArray(filter.AND) ? filter.AND : [filter.AND];
  return { ...filter, AND: [...and, ...compounds] };
}

const reportedMissing = new Set<string>();
const MAX_REPORTED = 500;

// The database already returns nothing here, so log once per call site to point
// at the missing runAsTenant / runAsSystem instead of an empty result.
function missingContext(model: string, operation: string): void {
  const error = new Error(`${model}.${operation} ran outside runAsTenant/runAsSystem`);
  const callSite = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .filter((frame) => !/row-security|@prisma|node:internal/.test(frame))
    .slice(0, 3)
    .join("\n");
  const key = `${model}.${operation}\n${callSite}`;
  if (reportedMissing.has(key) || reportedMissing.size >= MAX_REPORTED) return;
  reportedMissing.add(key);
  getLogger().error("database access without a tenant or system context", error, {
    model,
    operation,
  });
}

/**
 * The call sites logged since the last call, cleared as they are returned. Test
 * runs fail on any, so a path that reaches a protected table without a context
 * is caught in CI instead of returning nothing in production.
 */
export function drainUnscopedDatabaseAccess(): string[] {
  const sites = [...reportedMissing];
  reportedMissing.clear();
  return sites;
}

/**
 * Covers the two cases where Prisma, not the caller, decides when a
 * connection is checked out, so the pool would see the wrong context:
 * - outside a transaction, Prisma batches `findUnique` calls from one tick and
 *   runs them on the next, so each one runs as the equivalent findFirst;
 * - a batch `$transaction([...])` starts on the next tick as well, so it is
 *   rejected inside a context; use an interactive transaction instead.
 */
export function withRowLevelSecurity(prisma: PrismaClient, bypassKey = ""): PrismaClient {
  const models = (prisma as unknown as { _runtimeDataModel?: RuntimeDataModel })._runtimeDataModel
    ?.models;
  const fieldSets = new Map<string, Set<string>>();
  const fieldsOf = (model: string) => {
    const fields = models?.[model]?.fields;
    if (!fields) return undefined;
    let set = fieldSets.get(model);
    if (!set) {
      set = new Set(fields.map((field) => field.name));
      fieldSets.set(model, set);
    }
    return set;
  };
  return prisma.$extends({
    query: {
      async $allOperations({ model, operation, args, query, ...rest }) {
        const internal = (rest as { __internalParams?: InternalParams }).__internalParams;
        const transaction = internal?.transaction;
        // A lone statement that lost a deadlock changed nothing, so it can run again; a
        // transaction's statements are retried by whoever opened the transaction.
        const run = () => (transaction ? query(args) : withTransactionRetry(() => query(args)));
        const context = storage.getStore();
        if (!context) {
          if (model && ROW_SECURITY_MODELS.has(model)) missingContext(model, operation);
          return run();
        }
        if (transaction?.kind === "batch") {
          throw new Error(
            "Batch $transaction([...]) cannot carry a database context; use an interactive transaction",
          );
        }
        if (transaction || (operation !== "findUnique" && operation !== "findUniqueOrThrow")) {
          return run();
        }
        // Prisma would batch this with other findUnique calls of the same tick and
        // run them all in whichever context came first. findFirst runs at once,
        // in this one, with the same plan.
        const fields = model ? fieldsOf(model) : undefined;
        const where = (args as { where?: Where }).where;
        const filter =
          fields && where && !internal?.dataPath?.length && uniqueAsFilter(where, fields);
        if (model && filter) {
          const delegate = Reflect.get(prisma, model[0]!.toLowerCase() + model.slice(1));
          const first = operation === "findUnique" ? "findFirst" : "findFirstOrThrow";
          return withTransactionRetry(
            () =>
              Reflect.apply(delegate[first], delegate, [
                { ...args, where: filter },
              ]) as Promise<unknown>,
          );
        }
        // Fluent relation reads (`findUnique(...).messages()`) keep Prisma's own
        // shape, so they run in a short transaction that sets the context first.
        return withTransactionRetry(async () => {
          const [, result] = await prisma.$transaction(
            [prisma.$executeRaw(LOCAL_SETTINGS(settingsFor(context, bypassKey))), query(args)],
            WRAPPED_OPERATION_OPTIONS as never,
          );
          return result;
        });
      },
    },
  }) as unknown as PrismaClient;
}
