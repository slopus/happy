import type { PrismaClient } from '@prisma/client';
import { db } from '@/storage/db';
import { createAIServiceStore } from './store';
import { createServiceProbes } from './probes';
import { createServiceGrants } from './grants';
import { createServiceTurns } from './turns';
export function createSharedAIServices(database: PrismaClient) {
 const probes = createServiceProbes(database);
 const store = createAIServiceStore(database, probes.source);
 return { database, probes, store, grants: createServiceGrants(database,store), turns: createServiceTurns(database,store) };
}
export type SharedAIServices = ReturnType<typeof createSharedAIServices>;
export const sharedAIServices = createSharedAIServices(db);
