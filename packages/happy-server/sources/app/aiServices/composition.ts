import { eventRouter } from '@/app/events/eventRouter';
import type { PrismaClient } from '@prisma/client';
import { db } from '@/storage/db';
import { createAIServiceStore } from './store';
import { createServiceProbes } from './probes';
import { createServiceGrants } from './grants';
import { createServiceTurns } from './turns';
export function createSharedAIServices(database: PrismaClient) {
 const notifyWork=(ownerId:string,machineId:string)=>{
  // Delivery is best effort. Older/disconnected daemons retain bounded polling.
  try{eventRouter.emitEphemeral({userId:ownerId,recipientFilter:{type:'machine-only',machineId},payload:{type:'ai-service-work-available',machineId}});}catch{}
 };
 const probes = createServiceProbes(database,notifyWork);
 const store = createAIServiceStore(database, probes.source);
 return { database, probes, store, notifyWork, grants: createServiceGrants(database,store), turns: createServiceTurns(database,store) };
}
export type SharedAIServices = ReturnType<typeof createSharedAIServices>;
export const sharedAIServices = createSharedAIServices(db);
