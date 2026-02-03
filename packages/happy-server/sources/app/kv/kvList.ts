import { db } from "@/storage/db";
import * as privacyKit from "privacy-kit";

export interface KVListOptions {
    prefix?: string;
    limit?: number;
}

export interface KVListResult {
    items: Array<{
        key: string;
        value: string;
        version: number;
    }>;
}

/**
 * List all key-value pairs for the authenticated user, optionally filtered by prefix.
 * Returns keys, values, and versions. Excludes entries with null values (deleted).
 */
export async function kvList(
    ctx: { uid: string },
    options?: KVListOptions
): Promise<KVListResult> {
    const where: any = {
        accountId: ctx.uid,
        value: {
            not: null  // Exclude deleted entries (null values)
        }
    };

    // Add prefix filter if specified
    if (options?.prefix) {
        where.key = {
            startsWith: options.prefix
        };
    }

    const results = await db.userKVStore.findMany({
        where,
        orderBy: {
            key: 'asc'
        },
        take: options?.limit
    });

    return {
        items: results
            .filter(r => r.value !== null)  // Extra safety check
            .map(r => ({
                key: r.key,
                value: privacyKit.encodeBase64(r.value!),
                version: r.version
            }))
    };
}