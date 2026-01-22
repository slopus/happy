import { PrismaClient } from "@prisma/client";

export let db: PrismaClient;

export function initDbPostgres(): void {
    db = new PrismaClient();
}

export async function initDbSqlite(): Promise<void> {
    const clientUrl = new URL('../../generated/sqlite-client/index.js', import.meta.url);
    const mod: any = await import(clientUrl.toString());
    const SqlitePrismaClient: any = mod?.PrismaClient ?? mod?.default?.PrismaClient;
    if (!SqlitePrismaClient) {
        throw new Error('Failed to load sqlite PrismaClient (missing generated/sqlite-client)');
    }
    db = new SqlitePrismaClient() as PrismaClient;
}
