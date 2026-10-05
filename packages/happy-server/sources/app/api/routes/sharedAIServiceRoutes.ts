import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ServiceGrantScopeSchema, CapabilityCatalogSchema, ServiceTargetSchema, ServiceErrorSchema, TurnActualSchema, ServiceErrorCodeSchema } from '@slopus/happy-wire';
import type { Fastify } from '../types';
import type { SharedAIServices } from '@/app/aiServices/composition';
import { BindingOverridesSchema, readTrustedCatalog } from '@/app/aiServices/bindings';
import { authorizeServiceCredential } from '@/app/aiServices/authority';
import { createApplicationRegistry } from '@/app/aiServices/registry';
import { createServiceCodexGrant } from './codexAccountStore';
import { deny, AIServiceError } from '@/app/aiServices/errors';
const id = z.string().min(1).max(256), secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const envelope = z.string().min(80).max(16384);
const authority = z.object({ kind: z.enum(['probe','turn']), id, lease: secret }).strict();
export function sharedAIServiceRoutes(app: Fastify, services: SharedAIServices) {
 const { database, store, grants, turns, probes } = services;
 app.register(async instance => {
  const routes = instance.withTypeProvider<ZodTypeProvider>();
  routes.addHook('onRoute', options => { options.bodyLimit ??= 8192; });
  routes.addHook('onRequest', async (_request,reply) => { reply.header('Cache-Control','no-store'); reply.header('Referrer-Policy','no-referrer'); });
  routes.setErrorHandler((error,_request,reply) => {
   const code = error instanceof AIServiceError ? error.code : 'internal-error';
   const status = code === 'permission-denied' ? 403 : code === 'internal-error' ? (error as any).statusCode ?? 500 : 409;
   return reply.code(status).send({ error: { code: status === 400 || status === 413 ? 'invalid-request' : code, retryable: false } });
  });
  const authenticate = async (request: { headers: { authorization?: string; origin?: string } }) => grants.authenticate(request.headers.authorization?.replace(/^Bearer /,'') ?? '',request.headers.origin);
  routes.get('/v1/ai-services/protocol', async () => ({ protocol: 'ai-services/1', personalPairing: true, legacyProtocols: [1,2,3] }));
  routes.get('/v1/ai-services/workers', { preHandler: app.authenticate }, async request => ({ workers: await database.appChatWorker.findMany({ where: { accountId: request.userId, serviceProtocol: 'ai-services/1', activeUntil: { gt: new Date() } }, select: { machineId: true, serviceProtocol: true, servicePublicKey: true, serviceClaudeIdentity: true, serviceClaudeObservedAt: true } }) }));
  routes.post('/v1/ai-services/capabilities', { preHandler: app.authenticate, schema: { body: ServiceTargetSchema } }, async request => ({ catalog: await readTrustedCatalog(probes.source,request.userId,request.body) }));
  routes.get('/v1/ai-services/applications/:appId', { preHandler: app.authenticate, schema: { params: z.object({ appId: id }) } }, async request => ({ app: await store.readApplication(request.params.appId) }));
  routes.get('/v1/ai-services/bindings/:id', { preHandler: app.authenticate, schema: { params: z.object({ id }) } }, async request => { const row=await database.aIServiceBinding.findFirst({ where:{ id:request.params.id,ownerId:request.userId },select:{ appId:true } });if(!row)deny('permission-denied');return { binding:await store.readBinding({ kind:'owner',ownerId:request.userId },row.appId,request.params.id) }; });
  routes.get('/v1/ai-services/:serviceId/turns', { preHandler: app.authenticate, schema: { params: z.object({ serviceId: id }) } }, async request => {
   await store.readService(request.userId,request.params.serviceId);
   const rows = await database.appChatTurn.findMany({ where: { binding: { ownerId: request.userId, serviceId: request.params.serviceId } }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, bindingId: true, state: true, actual: true, createdAt: true, startedAt: true, completedAt: true, serviceError: true } });
   return { turns: rows };
  });
  routes.delete('/v1/ai-services/authorizations/:id', { preHandler: app.authenticate, schema: { params: z.object({ id }) } }, async request => { await store.revokeAuthorization(request.userId,request.params.id); return { revoked: true }; });
  const rate = new Map<string,{ count:number; until:number }>();
  const pairingLimit = async (request: { ip: string }) => {
   const now = Date.now(); for (const [key,value] of rate) if (value.until < now) rate.delete(key);
   const bucket = rate.get(request.ip) ?? { count:0,until:now+600000 };
   if (++bucket.count > 20 || (!rate.has(request.ip) && rate.size >= 4096)) deny('resource-busy');
   rate.set(request.ip,bucket);
  };
  routes.post('/v1/apps/ai-services/pairings', { preHandler: pairingLimit, schema: { body: z.object({ appId:id, publicKey:z.string().max(100), challengeHash:z.string().length(64) }).strict() } }, async request => grants.createPersonalPairing(request.body.appId,request.headers.origin ?? '',request.body.publicKey,request.body.challengeHash));
  routes.get('/v1/ai-services/pairings/:id', { preHandler: app.authenticate, schema: { params:z.object({ id }) } }, request => grants.describePersonalPairing(request.params.id));
  routes.post('/v1/ai-services/pairings/:id/approve', { preHandler: app.authenticate, bodyLimit: 1100000, schema: { params:z.object({ id }), body:z.object({ scope:ServiceGrantScopeSchema, appEnvelope:envelope, machineEnvelopes:z.record(z.string(),envelope) }).strict() } }, request => grants.approvePersonalPairing(request.userId,request.params.id,request.body.scope,request.body.appEnvelope,request.body.machineEnvelopes));
  routes.post('/v1/apps/ai-services/pairings/:id/redeem', { schema: { params:z.object({ id }), body:z.object({ verifier:secret, credential:secret }).strict() } }, request => grants.redeemPersonalPairing(request.params.id,request.headers.origin ?? '',request.body.verifier,request.body.credential));
  routes.get('/v1/apps/services', async request => {
   const principal = await authenticate(request);
   return { services: [(await store.readService(principal.ownerId,principal.scope.serviceId)).service], app: await store.readApplication(principal.scope.appId) };
  });
  routes.post('/v1/apps/ai-services/bindings', { schema: { body:z.object({ overrides:BindingOverridesSchema, appConversationId:id.optional() }).strict() } }, async request => {
   const p = await authenticate(request); return { binding:await store.resolveBinding(p,p.scope.appId,p.scope.serviceId,request.body.overrides,request.body.appConversationId) };
  });
  routes.get('/v1/apps/ai-services/conversations/:appConversationId/binding', { schema: { params:z.object({ appConversationId:id }) } }, async request => { const p=await authenticate(request);return { binding:await store.findApplicationBinding(p,p.scope.appId,request.params.appConversationId) }; });
  routes.get('/v1/apps/ai-services/bindings/:bindingId', { schema: { params:z.object({ bindingId:id }) } }, async request => { const p=await authenticate(request); return { binding:await store.readBinding(p,p.scope.appId,request.params.bindingId) }; });
  routes.post('/v1/apps/ai-services/capabilities', async request => {
   const p=await authenticate(request), revision=(await store.readService(p.ownerId,p.scope.serviceId)).revision;
   return { catalog:await readTrustedCatalog(probes.source,p.ownerId,revision.config,p) };
  });
  routes.post('/v1/apps/ai-services/bindings/:bindingId/turns', { bodyLimit:9*1024*1024, schema:{ params:z.object({ bindingId:id }), body:z.object({ requestId:id, ciphertext:z.string().min(60).max(8*1024*1024) }).strict() } }, async (request, reply) => {
   try { return { record: await turns.startBoundTurn(await authenticate(request), request.params.bindingId, request.body.requestId, { ciphertext: request.body.ciphertext }) }; }
   catch (error) {
    if (!(error instanceof AIServiceError)) throw error;
    // This invocation did not admit a turn. Clients must retain uncertainty for any prior attempt.
    return reply.code(error.code === 'permission-denied' ? 403 : 409).send({ error: { code: error.code, retryable: error.retryable, submission: 'not-submitted', requestId: request.body.requestId } });
   }
  });
  routes.get('/v1/apps/ai-services/bindings/:bindingId/turns', { schema:{ params:z.object({ bindingId:id }), querystring:z.object({ cursor:id.optional() }).strict() } }, async request => turns.readTurns(await authenticate(request),request.params.bindingId,request.query.cursor));
  routes.get('/v1/apps/ai-services/bindings/:bindingId/requests/:requestId', { schema:{ params:z.object({ bindingId:id,requestId:id }) } }, async request => turns.readBoundRequest(await authenticate(request),request.params.bindingId,request.params.requestId));
  routes.get('/v1/apps/ai-services/bindings/:bindingId/turns/:id', { schema:{ params:z.object({ bindingId:id,id }) } }, async request => turns.readBoundTurn(await authenticate(request),request.params.bindingId,request.params.id));
  routes.post('/v1/apps/ai-services/bindings/:bindingId/turns/:id/cancel', { schema:{ params:z.object({ bindingId:id,id }) } }, async request => turns.cancelBoundTurn(await authenticate(request),request.params.bindingId,request.params.id));
  const machineParams=z.object({ machineId:id });
  routes.post('/v1/ai-service-worker/:machineId/announce', { preHandler:app.authenticate,schema:{ params:machineParams,body:z.object({ protocol:z.literal('ai-services/1'),publicKey:z.string().max(100),claudeIdentity:z.object({ identityId:z.string().regex(/^claude:[a-f0-9]{64}$/),observedAt:z.number().int().nonnegative() }).strict().nullable().optional() }).strict() } }, request => probes.announce(request.userId,request.params.machineId,request.body.publicKey,request.body.claudeIdentity));
  routes.post('/v1/ai-service-worker/:machineId/claim', { preHandler:app.authenticate,schema:{ params:machineParams } }, async request => {
   const probe=await probes.claim(request.userId,request.params.machineId);
   if (!probe && await database.aIServiceProbe.count({ where:{ ownerId:request.userId,machineId:request.params.machineId,state:'running',deadline:{ gt:new Date() } } })) return { probe:null,job:null };
   return probe ? { probe,job:null } : { probe:null,job:await turns.claim(request.userId,request.params.machineId) };
  });
  routes.post('/v1/ai-service-worker/:machineId/probes/:id', { preHandler:app.authenticate,bodyLimit:1024*1024,schema:{ params:z.object({ machineId:id,id }),body:z.object({ lease:secret,catalog:CapabilityCatalogSchema.nullable(),error:ServiceErrorCodeSchema.optional() }).strict() } }, request => probes.publish(request.userId,request.params.machineId,request.params.id,request.body.lease,request.body.catalog,request.body.error));
  routes.post('/v1/ai-service-worker/:machineId/authority', { preHandler:app.authenticate,schema:{ params:machineParams,body:authority } }, request => database.$transaction(async tx => { const target=await authorizeServiceCredential(tx,request.userId,request.params.machineId,request.body); return { target:{ machineId:target.machineId,engine:target.engine,accountRef:target.accountRef } }; }));
  routes.post('/v1/ai-service-worker/:machineId/credential', { preHandler:app.authenticate,schema:{ params:machineParams,body:authority } }, request => database.$transaction(tx => createServiceCodexGrant(tx,request.userId,request.params.machineId,request.body)));
  routes.post('/v1/ai-service-worker/:machineId/policy', { preHandler:app.authenticate,schema:{ params:machineParams,body:authority } }, request => database.$transaction(async tx => {
   if (request.body.kind !== 'turn') deny('permission-denied');
   const binding=await authorizeServiceCredential(tx,request.userId,request.params.machineId,request.body);
   if (!('appId' in binding) || typeof binding.appId !== 'string') deny('permission-denied');
   const registry=createApplicationRegistry(tx), policy=await registry.readApplication(binding.appId);
   const prompt=await registry.resolveBusinessPrompt(policy.businessPrompt);
   if (!prompt) deny('protocol-incompatible');
   return { policy,prompt,ref:policy.businessPrompt };
  }));
  routes.post('/v1/ai-service-worker/:machineId/turns/:id', { preHandler:app.authenticate,bodyLimit:2*1024*1024,schema:{ params:z.object({ machineId:id,id }),body:z.object({ lease:secret,output:z.string().min(60).max(1024*1024).optional(),sequence:z.number().int().positive().optional(),status:z.enum(['completed','failed','cancelled']).optional(),actual:TurnActualSchema.optional(),error:ServiceErrorSchema.optional() }).strict() } }, request => turns.publish(request.userId,request.params.machineId,request.params.id,request.body));
 });
}
