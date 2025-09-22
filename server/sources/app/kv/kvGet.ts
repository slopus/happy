import { db } from "@/storage/db";
import * as privacyKit from "privacy-kit";

export type KVGetResult = {
    key: string;
    value: string;
    version: number;
} | null;

/**
 * Get a single key-value pair for the authenticated user.
 * Returns null if the key doesn't exist or if the value is null (deleted).
 */
export async function kvGet(
    ctx: { uid: string },
    key: string
): Promise<KVGetResult> {
    const result = await db.userKVStore.findUnique({
        where: {
            accountId_key: {
                accountId: ctx.uid,
                key
            }
        }
    });

    // Treat missing records and null values as "not found"
    if (!result || result.value === null) {
        return null;
    }

    return {
        key: result.key,
        value: privacyKit.encodeBase64(result.value),
        version: result.version
    };
}