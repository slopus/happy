import { Tx } from "@/storage/inTx";


export async function fetchRepeatKey(tx: Tx, key: string) {
    let session = await tx.repeatKey.findUnique({ where: { key, expiresAt: { gte: new Date() } } });
    if (session) {
        return session.value;
    } else {
        return null;
    }
}

export async function saveRepeatKey(tx: Tx, key: string, value: string, timeout: number = Date.now() + (1000 * 60 * 60 * 24) /* 1 day */) {
    await tx.repeatKey.upsert({
        where: { key },
        create: { key, value, expiresAt: new Date(timeout) },
        update: { key, value, expiresAt: new Date(timeout) }
    });
}

export async function repeatKey(tx: Tx, key: string, value: string, timeout: number = Date.now() + (1000 * 60 * 60 * 24) /* 1 day */): Promise<boolean> {
    let session = await tx.repeatKey.findUnique({ where: { key, expiresAt: { lte: new Date() } } });
    if (session) {
        return false;
    }
    await tx.repeatKey.upsert({
        where: { key },
        create: { key, value, expiresAt: new Date(timeout) },
        update: { key, value, expiresAt: new Date(timeout) }
    });
    return true;
}