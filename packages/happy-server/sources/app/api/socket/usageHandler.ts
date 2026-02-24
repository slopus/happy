import { Socket } from "socket.io";
import { AsyncLock } from "@/utils/lock";
import { db } from "@/storage/db";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";

function toFiniteNumber(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return value;
}

function mergeUsageMetricMaps(
    previous: Record<string, unknown> | undefined,
    incoming: Record<string, unknown>,
): { total: number; [key: string]: number } {
    const merged: Record<string, number> = {};

    if (previous && typeof previous === 'object') {
        for (const [key, value] of Object.entries(previous)) {
            const num = toFiniteNumber(value);
            if (num !== null) {
                merged[key] = num;
            }
        }
    }

    for (const [key, value] of Object.entries(incoming)) {
        const num = toFiniteNumber(value);
        if (num !== null) {
            merged[key] = (merged[key] || 0) + num;
        }
    }

    if (typeof merged.total !== 'number') {
        merged.total = 0;
    }

    return merged as { total: number; [key: string]: number };
}

export function usageHandler(userId: string, socket: Socket) {
    const receiveUsageLock = new AsyncLock();
    socket.on('usage-report', async (data: any, callback?: (response: any) => void) => {
        await receiveUsageLock.inLock(async () => {
            try {
                const { key, sessionId, tokens, cost } = data;

                // Validate required fields
                if (!key || typeof key !== 'string') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid key' });
                    }
                    return;
                }

                // Validate tokens and cost objects
                if (!tokens || typeof tokens !== 'object' || typeof tokens.total !== 'number') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid tokens object - must include total' });
                    }
                    return;
                }

                if (!cost || typeof cost !== 'object' || typeof cost.total !== 'number') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid cost object - must include total' });
                    }
                    return;
                }

                // Validate sessionId if provided
                if (sessionId && typeof sessionId !== 'string') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid sessionId' });
                    }
                    return;
                }

                try {
                    // If sessionId provided, verify it belongs to the user
                    if (sessionId) {
                        const session = await db.session.findFirst({
                            where: {
                                id: sessionId,
                                accountId: userId
                            }
                        });

                        if (!session) {
                            if (callback) {
                                callback({ success: false, error: 'Session not found' });
                            }
                            return;
                        }
                    }

                    // Prepare usage data
                    let usageData: PrismaJson.UsageReportData = {
                        tokens,
                        cost
                    };

                    const uniqueWhere = {
                        accountId_sessionId_key: {
                            accountId: userId,
                            sessionId: sessionId || null,
                            key,
                        }
                    };

                    const existing = await db.usageReport.findUnique({
                        where: uniqueWhere,
                        select: { data: true }
                    });

                    if (existing) {
                        const previousData = existing.data as PrismaJson.UsageReportData;
                        usageData = {
                            tokens: mergeUsageMetricMaps(previousData?.tokens as Record<string, unknown> | undefined, tokens),
                            cost: mergeUsageMetricMaps(previousData?.cost as Record<string, unknown> | undefined, cost),
                        };
                    }

                    // Upsert the usage report
                    const report = await db.usageReport.upsert({
                        where: uniqueWhere,
                        update: {
                            data: usageData,
                            updatedAt: new Date()
                        },
                        create: {
                            accountId: userId,
                            sessionId: sessionId || null,
                            key,
                            data: usageData
                        }
                    });

                    log({ module: 'websocket' }, `Usage report saved: key=${key}, sessionId=${sessionId || 'none'}, userId=${userId}`);

                    // Emit usage ephemeral update if sessionId is provided
                    if (sessionId) {
                        const usageEvent = buildUsageEphemeral(sessionId, key, usageData.tokens, usageData.cost);
                        eventRouter.emitEphemeral({
                            userId,
                            payload: usageEvent,
                            recipientFilter: { type: 'user-scoped-only' }
                        });
                    }

                    if (callback) {
                        callback({
                            success: true,
                            reportId: report.id,
                            createdAt: report.createdAt.getTime(),
                            updatedAt: report.updatedAt.getTime()
                        });
                    }
                } catch (error) {
                    log({ module: 'websocket', level: 'error' }, `Failed to save usage report: ${error}`);
                    if (callback) {
                        callback({ success: false, error: 'Failed to save usage report' });
                    }
                }
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in usage-report handler: ${error}`);
                if (callback) {
                    callback({ success: false, error: 'Internal error' });
                }
            }
        });
    });
}
