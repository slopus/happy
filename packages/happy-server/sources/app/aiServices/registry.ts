import type { PrismaClient, Prisma } from '@prisma/client';
import { AppPolicySchema, type AppPolicy } from '@slopus/happy-wire';
import { deny } from './errors';

type Database = PrismaClient | Prisma.TransactionClient;
export function createApplicationRegistry(database: Database) {
    return {
        async readApplication(appId: string, origin?: string): Promise<AppPolicy> {
            const row = await database.aIServiceApplication.findUnique({ where: { appId } });
            if (!row?.enabled) deny('permission-denied');
            const parsed = AppPolicySchema.safeParse(row.policy);
            if (!parsed.success || parsed.data.appId !== appId) deny('permission-denied');
            if (origin !== undefined && !parsed.data.origins.includes(origin)) deny('permission-denied');
            return parsed.data;
        },
        /** Administrator-only composition API. Never expose as a client registration route. */
        async registerApplication(input: AppPolicy): Promise<AppPolicy> {
            const parsed = AppPolicySchema.safeParse(input);
            if (!parsed.success) deny('invalid-request');
            await database.aIServiceApplication.create({ data: { appId: parsed.data.appId, policy: parsed.data } });
            return parsed.data;
        },
    };
}
