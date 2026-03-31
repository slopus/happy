import { z } from 'zod';
import { Fastify } from '../types';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { log } from '@/utils/log';

export function devRoutes(app: Fastify) {

    if (process.env.DEV_AUTH_ENABLED === 'true') {
        app.post('/v1/auth/dev-token', async (_request, reply) => {
            // Prefer the account that owns machines (i.e. the CLI daemon's account)
            const machineOwner = await db.machine.findFirst({
                orderBy: { lastActiveAt: 'desc' },
                select: { accountId: true }
            });
            let account;
            if (machineOwner) {
                account = await db.account.findUnique({ where: { id: machineOwner.accountId } });
            }
            if (!account) {
                account = await db.account.upsert({
                    where: { publicKey: 'dev-web-console' },
                    update: { updatedAt: new Date() },
                    create: { publicKey: 'dev-web-console' }
                });
            }
            const token = await auth.createToken(account.id);
            log({ module: 'dev' }, `Dev token issued for account ${account.id}`);
            return reply.send({ token });
        });
    }

    // Combined logging endpoint (only when explicitly enabled)
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) {
        app.post('/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
            schema: {
                body: z.object({
                    timestamp: z.string(),
                    level: z.string(),
                    message: z.string(),
                    messageRawObject: z.any().optional(),
                    source: z.enum(['mobile', 'cli']),
                    platform: z.string().optional()
                })
            }
        }, async (request, reply) => {
            const { timestamp, level, message, source, platform } = request.body;

            // Log ONLY to separate remote logger (file only, no console)
            const logData = {
                source,
                platform,
                timestamp
            };

            // Use the file-only logger if available
            const { fileConsolidatedLogger } = await import('@/utils/log');

            if (!fileConsolidatedLogger) {
                // Should never happen since we check env var above, but be safe
                return reply.send({ success: true });
            }

            switch (level.toLowerCase()) {
                case 'error':
                    fileConsolidatedLogger.error(logData, message);
                    break;
                case 'warn':
                case 'warning':
                    fileConsolidatedLogger.warn(logData, message);
                    break;
                case 'debug':
                    fileConsolidatedLogger.debug(logData, message);
                    break;
                default:
                    fileConsolidatedLogger.info(logData, message);
            }

            return reply.send({ success: true });
        });
    }
}