import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/);
export const STANDALONE_LAUNCH_ENV = 'HAPPY_STANDALONE_LAUNCH_V1';
export const launchBootstrapSchema = z.object({ version: z.literal(1), instanceId: id, launchId: id,
  port: z.number().int().min(1).max(65535), secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type StandaloneLaunchBootstrap = z.infer<typeof launchBootstrapSchema>;
/** Consume before any command starts subprocesses. Never include the rejected value in an error. */
export function consumeStandaloneLaunchBootstrap(env: NodeJS.ProcessEnv): StandaloneLaunchBootstrap | undefined {
  const raw = env[STANDALONE_LAUNCH_ENV]; delete env[STANDALONE_LAUNCH_ENV];
  if (raw === undefined) return undefined;
  try {
    if (raw.length > 1024) throw new Error();
    return launchBootstrapSchema.parse(JSON.parse(raw));
  } catch { throw new Error('Invalid standalone launch bootstrap'); }
}
export const launchCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('drain'), nonce: id, sessionBudgetMs: z.number().finite().positive().max(30000),
    releaseBudgetMs: z.number().finite().positive().max(10000) }).strict(),
  z.object({ type: z.literal('release'), nonce: id }).strict(),
  z.object({ type: z.literal('ack'), nonce: id }).strict(),
  z.object({ type: z.literal('abandon'), nonce: id }).strict(),
]);
export const launchReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), instanceId: id, launchId: id }).strict(),
  z.object({ type: z.literal('receipt'), nonce: id, launchId: id, stored: z.boolean(),
    ownership: z.enum(['none', 'held', 'unknown']), reason: z.string().max(128).nullable() }).strict(),
  z.object({ type: z.literal('intent'), nonce: id, launchId: id }).strict(),
  z.object({ type: z.literal('outcome'), nonce: id, launchId: id, decision: z.enum(['none', 'confirmed', 'blocked']) }).strict(),
]);

/** The runtimes that implement the session drain; nothing else may run in the Windows standalone runtime. */
export const STANDALONE_DRAIN_PROVIDERS = ['codex', 'claude'] as const;
const DRAINABLE_COMMANDS: ReadonlySet<string> = new Set(STANDALONE_DRAIN_PROVIDERS);
// index.ts captures before loading provider modules with import-time side effects.
let entryBootstrap: StandaloneLaunchBootstrap | undefined;
export function captureStandaloneLaunchBootstrap(env: NodeJS.ProcessEnv, command: string | undefined): void {
  entryBootstrap = consumeStandaloneLaunchBootstrap(env);
  if (entryBootstrap && !DRAINABLE_COMMANDS.has(command ?? '')) {
    entryBootstrap = undefined; throw new Error('Standalone launch requires a drainable agent');
  }
}
export function takeStandaloneLaunchBootstrap(env: NodeJS.ProcessEnv): StandaloneLaunchBootstrap | undefined {
  const bootstrap = entryBootstrap ?? consumeStandaloneLaunchBootstrap(env);
  entryBootstrap = undefined;
  return bootstrap;
}

export function launchAuthProof(config: StandaloneLaunchBootstrap, side: 'client' | 'server', nonce: string): string {
  return createHmac('sha256', Buffer.from(config.secret, 'hex'))
    .update(JSON.stringify([1, side, config.instanceId, config.launchId, config.port, nonce])).digest('hex');
}
export function equalLaunchProof(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
export const launchAuthenticationSchema = z.object({ type: z.literal('authenticated'),
  nonce: z.string().regex(/^[a-f0-9]{64}$/), proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
