import { Prisma, PrismaClient } from "@prisma/client";

export { Prisma };
export type TransactionClient = Prisma.TransactionClient;
export type PrismaClientType = PrismaClient;

export * from "./enums.generated";

let _db: PrismaClientType | null = null;

export const db: PrismaClientType = new Proxy({} as PrismaClientType, {
    get(_target, prop) {
        if (!_db) {
            if (prop === Symbol.toStringTag) return "PrismaClient";
            // Avoid accidental `await db` treating it like a thenable.
            if (prop === "then") return undefined;
            throw new Error("Database client is not initialized. Call initDbPostgres() or initDbSqlite() before using db.");
        }
        const value = (_db as any)[prop];
        return typeof value === "function" ? value.bind(_db) : value;
    },
    set(_target, prop, value) {
        if (!_db) {
            throw new Error("Database client is not initialized. Call initDbPostgres() or initDbSqlite() before using db.");
        }
        (_db as any)[prop] = value;
        return true;
    },
}) as PrismaClientType;

export function initDbPostgres(): void {
    _db = new PrismaClient();
}

export async function initDbSqlite(): Promise<void> {
    const clientUrl = new URL("../../generated/sqlite-client/index.js", import.meta.url);
    const mod: any = await import(clientUrl.toString());
    const SqlitePrismaClient: any = mod?.PrismaClient ?? mod?.default?.PrismaClient;
    if (!SqlitePrismaClient) {
        throw new Error("Failed to load sqlite PrismaClient (missing generated/sqlite-client)");
    }
    const client = new SqlitePrismaClient() as PrismaClientType;

    // SQLite can throw transient "database is locked" / SQLITE_BUSY under concurrent writes,
    // especially in CI where we spawn many sessions in parallel. Add a small retry layer and
    // increase busy timeout to make light/sqlite a viable test backend.
    const isSqliteBusyError = (err: unknown): boolean => {
        const message = err instanceof Error ? err.message : String(err);
        return message.includes("SQLITE_BUSY") || message.includes("database is locked");
    };

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    client.$use(async (params, next) => {
        // Only retry writes (reads are generally safe and should fail fast if they fail).
        const action = params.action;
        const isWrite =
            action === "create" ||
            action === "createMany" ||
            action === "update" ||
            action === "updateMany" ||
            action === "upsert" ||
            action === "delete" ||
            action === "deleteMany";

        if (!isWrite) {
            return await next(params);
        }

        const maxRetries = 6;
        let attempt = 0;
        while (true) {
            try {
                return await next(params);
            } catch (e) {
                if (!isSqliteBusyError(e) || attempt >= maxRetries) {
                    throw e;
                }
                const backoffMs = 25 * Math.pow(2, attempt);
                attempt += 1;
                await sleep(backoffMs);
            }
        }
    });

    // These PRAGMAs are applied per connection; Prisma may use a pool, but even setting them once
    // on startup helps CI stability. We keep the connection open; shutdown handler will disconnect.
    await client.$connect();
    // NOTE: Some PRAGMAs (e.g. `journal_mode`) return results; use `$queryRaw*` to avoid P2010.
    await client.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await client.$queryRawUnsafe("PRAGMA busy_timeout=5000");

    _db = client;
}

export function isPrismaErrorCode(err: unknown, code: string): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }
    return (err as any).code === code;
}
