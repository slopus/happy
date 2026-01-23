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
    _db = new SqlitePrismaClient() as PrismaClientType;
}

export function isPrismaErrorCode(err: unknown, code: string): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }
    return (err as any).code === code;
}
