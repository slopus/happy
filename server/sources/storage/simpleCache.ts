import { db } from "@/storage/db";

export async function writeToSimpleCache(key: string, value: string) {
    await db.simpleCache.upsert({
        where: { key },
        update: { value },
        create: { key, value }
    });
}

export async function readFromSimpleCache(key: string): Promise<string | null> {
    const cache = await db.simpleCache.findFirst({
        where: { key }
    });
    return cache?.value ?? null;
}

export async function runCachedBoolean(key: string, execute: () => Promise<boolean>): Promise<boolean> {
    let value = await readFromSimpleCache(key);
    if (value === null) {
        value = (await execute()) ? 'true' : 'false';
        await writeToSimpleCache(key, value);
    }
    return value === 'true';
}

export async function runCachedString(key: string, execute: () => Promise<string>): Promise<string> {
    let value = await readFromSimpleCache(key);
    if (value === null) {
        value = await execute();
        await writeToSimpleCache(key, value);
    }
    return value;
}