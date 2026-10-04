import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod';
import type nacl from 'tweetnacl';
import { decryptScriptValue, encryptScriptValue, scriptAdmissionSchema, scriptAutomationPayloadSchema,
  scriptEncryptedValueSchema, scriptScheduleSchema, type ScriptAutomationPayload, type ScriptManagementRequest } from '@slopus/happy-wire';
import { readLocalHappyAgentCredentials } from '@/resume/localHappyAgentAuth';
import { readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { readMachineAutomationKey } from '@/daemon/automations/machineAutomationKey';
import { refreshMcpCallerGrantIfExpiring } from '@/aplus/refreshMcpCallerGrant';

const id = z.string().min(1).max(200);
const action = scriptAutomationPayloadSchema.shape.action.shape;
export const scriptAutomationToolRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('get'), automationId: id }),
  z.strictObject({ operation: z.literal('upsert'), registrationKey: id, expectedRevision: z.number().int().nonnegative(), sourcePath: z.string().min(1).max(1000),
    name: scriptAutomationPayloadSchema.shape.name, schedule: scriptScheduleSchema.nullable(), paused: z.boolean().default(false),
    externalEnabled: z.boolean().default(false), inputSchema: scriptAutomationPayloadSchema.shape.inputSchema.default({}),
    args: action.args.default([]), timeoutSeconds: action.timeoutSeconds.default(300), secretRefs: action.secretRefs.default({}), allowedOrigins: action.allowedOrigins.default([]) }),
  z.strictObject({ operation: z.literal('run'), automationId: id, input: z.record(z.string(), z.json()), idempotencyKey: id }),
  z.strictObject({ operation: z.literal('list_runs'), automationId: id, runId: id.optional() }),
  z.strictObject({ operation: z.literal('set_enabled'), automationId: id, expectedRevision: z.number().int().positive(), enabled: z.boolean() }),
]);
const rowSchema = z.object({ id, projectId: id, registrationKey: id, revision: z.number().int().positive(), generation: z.number().int().positive(),
  paused: z.boolean(), viewerKeyVersion: z.number().int().positive(), machineKeyVersion: z.number().int().positive(),
  encrypted: scriptEncryptedValueSchema, admission: scriptAdmissionSchema, machineId: z.string().optional(), ready: z.boolean().optional(), nextRunAt: z.number().nullable().optional() });
type Row = z.infer<typeof rowSchema>;
export function createScriptAutomationTools(options: {
  projectId: string; directory: string; viewerKeyPair: nacl.BoxKeyPair;
  /**
   * The automation key of the daemon on this machine, if readable. Code registered for that
   * daemon is sealed by it (aplus-dev-studio specs/e2ee-machine-control-boundary R13); the
   * agent holds no customer key to seal with.
   */
  localAutomationKey?: { publicKey: Uint8Array; secretKey: Uint8Array } | null;
  request(input: ScriptManagementRequest): Promise<unknown>;
}) {
  const context = (resourceId: string, purpose: 'configuration' | 'artifact' | 'log') => ({ projectId: options.projectId, resourceId, purpose });
  function payload(row: Row) {
    if (row.projectId !== options.projectId) throw new Error('SCRIPT_PROJECT_MISMATCH');
    return scriptAutomationPayloadSchema.parse(decryptScriptValue({ encrypted: row.encrypted, context: context(row.registrationKey, 'configuration'), recipient: 'viewer', secretKey: options.viewerKeyPair.secretKey }));
  }
  function summary(row: Row) {
    const value = payload(row);
    return { id: row.id, registrationKey: row.registrationKey, name: value.name, revision: row.revision, generation: row.generation,
      paused: row.paused, ready: row.ready ?? false, machineId: row.machineId ?? null, nextRunAt: row.nextRunAt ?? null,
      schedule: value.schedule, externalEnabled: value.externalEnabled, action: value.action, inputSchema: value.inputSchema };
  }
  async function list() { return z.object({ automations: z.array(rowSchema) }).parse(await options.request({ operation: 'list' })).automations; }
  async function target() {
    const schema = z.object({ automationProtocolVersion: z.number(), machinePublicKey: z.string(), machineKeyVersion: z.number(), viewerPublicKey: z.string().nullable(), viewerKeyVersion: z.number() });
    let value = schema.parse(await options.request({ operation: 'target' }));
    if (value.automationProtocolVersion < 5) throw new Error('SCRIPT_RUNNER_UNSUPPORTED');
    const publicKey = Buffer.from(options.viewerKeyPair.publicKey).toString('base64');
    if (!value.viewerPublicKey) {
      await options.request({ operation: 'viewer-key', expectedKeyVersion: value.viewerKeyVersion, publicKey });
      value = schema.parse(await options.request({ operation: 'target' }));
    }
    if (!value.viewerPublicKey || !Buffer.from(value.viewerPublicKey, 'base64').equals(Buffer.from(options.viewerKeyPair.publicKey))) throw new Error('SCRIPT_VIEWER_KEY_MISMATCH');
    return { ...value, publicKey, machinePublicKey: new Uint8Array(Buffer.from(value.machinePublicKey, 'base64')) };
  }
  async function sourceFile(path: string) {
    if (isAbsolute(path)) throw new Error('SCRIPT_SOURCE_OUTSIDE_PROJECT');
    const root = await realpath(options.directory);
    const file = await realpath(resolve(root, path));
    const inside = relative(root, file);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('SCRIPT_SOURCE_OUTSIDE_PROJECT');
    const info = await stat(file);
    if (!info.isFile() || info.size > 3 * 1024 * 1024) throw new Error('SCRIPT_SOURCE_TOO_LARGE');
    return { source: await readFile(file, 'utf8'), entrypoint: basename(file) };
  }
  return {
    async execute(raw: unknown): Promise<unknown> {
      const input = scriptAutomationToolRequestSchema.parse(raw);
      if (input.operation === 'run') return options.request(input);
      if (input.operation === 'list_runs') {
        const response = z.object({ runs: z.array(z.object({ id: z.string() }).passthrough()) }).parse(await options.request({ operation: 'runs', automationId: input.automationId }));
        const runs = response.runs.filter((run) => !input.runId || run.id === input.runId).slice(0, 10);
        if (!input.runId || !runs.length) return runs;
        const { logCiphertext } = z.object({ logCiphertext: z.string().nullable() }).parse(await options.request({ operation: 'runs', automationId: input.automationId, runId: input.runId }));
        return runs.map((run) => ({ ...run, ...(logCiphertext ? { log: decryptScriptValue({ encrypted: JSON.parse(logCiphertext),
          context: context(run.id, 'log'), recipient: 'viewer', secretKey: options.viewerKeyPair.secretKey }) } : {}) }));
      }
      if (input.operation === 'upsert') {
        const file = await sourceFile(input.sourcePath);
        const keys = await target();
        const digest = createHash('sha256').update(file.source).digest('hex');
        const artifactId = `code_${createHash('sha256').update(JSON.stringify([options.projectId, input.registrationKey, input.expectedRevision, digest])).digest('hex')}`;
        const value: ScriptAutomationPayload = scriptAutomationPayloadSchema.parse({ version: 3, name: input.name, schedule: input.schedule,
          externalEnabled: input.externalEnabled, inputSchema: input.inputSchema, action: { kind: 'script', runtime: 'node', artifactId, digest,
            entrypoint: file.entrypoint, args: input.args, timeoutSeconds: input.timeoutSeconds, secretRefs: input.secretRefs, allowedOrigins: input.allowedOrigins } });
        const existing = (await list()).find((row) => row.registrationKey === input.registrationKey);
        if (existing && existing.revision !== input.expectedRevision) {
          if (existing.revision === input.expectedRevision + 1 && existing.paused === input.paused && isDeepStrictEqual(payload(existing), value)) return summary(existing);
          throw new Error('REVISION_CONFLICT');
        }
        const ownMachine = !!options.localAutomationKey
          && Buffer.from(options.localAutomationKey.publicKey).equals(Buffer.from(keys.machinePublicKey));
        const recipients = { viewerPublicKey: options.viewerKeyPair.publicKey, machinePublicKey: keys.machinePublicKey,
          ...(ownMachine ? { sender: options.localAutomationKey! } : {}) };
        const encrypted = encryptScriptValue({ value, context: context(input.registrationKey, 'configuration'), ...recipients });
        const artifact = encryptScriptValue({ value: { source: file.source }, context: context(artifactId, 'artifact'), ...recipients });
        const response = z.object({ automation: rowSchema }).parse(await options.request({ operation: 'upsert', registration: {
          registrationKey: input.registrationKey, expectedRevision: input.expectedRevision, paused: input.paused,
          viewerKeyVersion: keys.viewerKeyVersion, machineKeyVersion: keys.machineKeyVersion, encrypted,
          admission: { artifactId, digest, schedule: value.schedule, externalEnabled: value.externalEnabled, inputSchema: value.inputSchema },
          artifact,
        } }));
        return summary(response.automation);
      }
      const rows = await list();
      if (input.operation === 'list') return rows.map(summary);
      const row = rows.find((row) => row.id === input.automationId);
      if (!row) throw new Error('NOT_FOUND');
      if (input.operation === 'get') return summary(row);
      if (row.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT');
      const response = z.object({ automation: rowSchema }).parse(await options.request({ operation: 'upsert', registration: {
        registrationKey: row.registrationKey, expectedRevision: row.revision, paused: !input.enabled, viewerKeyVersion: row.viewerKeyVersion,
        machineKeyVersion: row.machineKeyVersion, encrypted: row.encrypted, admission: row.admission,
      } }));
      return summary(response.automation);
    },
  };
}

// Chat sessions have no project_id in their config URL; their grant names the Chat, whose automation scope is `chat:<chatId>`.
// The server verifies the grant signature; this only picks the scope to ask for.
export function resolveScriptAutomationScope(configUrl: string, callerGrant: string | undefined): string | null {
  const projectId = new URL(configUrl).searchParams.get('project_id')?.trim();
  if (projectId) return projectId;
  try {
    const payload = JSON.parse(Buffer.from(callerGrant?.split('.')[0] ?? '', 'base64url').toString('utf8')) as { personalChatId?: unknown };
    return typeof payload?.personalChatId === 'string' && payload.personalChatId ? `chat:${payload.personalChatId}` : null;
  } catch {
    return null;
  }
}

export async function runScriptAutomationTool(raw: unknown, session: { directory: string; machineId?: string }) {
  const configUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL;
  const credentials = readLocalHappyAgentCredentials();
  const machineId = session.machineId ?? (await readSettings()).machineId;
  if (!configUrl || !credentials || !machineId) throw new Error('SCRIPT_AGENT_CONTEXT_REQUIRED');
  const url = new URL(configUrl);
  // The grant refresh keeps the grant's own scope; it reads project_id from the config URL itself.
  await refreshMcpCallerGrantIfExpiring(credentials.token, machineId);
  const callerGrant = process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
  if (!callerGrant) throw new Error('SCRIPT_AGENT_CONTEXT_REQUIRED');
  const projectId = resolveScriptAutomationScope(configUrl, callerGrant);
  if (!projectId) throw new Error('SCRIPT_PROJECT_CONTEXT_REQUIRED');
  const client = createScriptAutomationTools({ projectId, directory: session.directory, viewerKeyPair: credentials.contentKeyPair,
    localAutomationKey: readMachineAutomationKey(configuration.automationKeyFile),
    request: async (request) => {
      const response = await fetch(new URL('/api/automation/script-management', url), { method: 'POST',
        headers: { Authorization: `Bearer ${credentials.token}`, 'X-Aplus-Caller-Grant': callerGrant, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, machineId, request }), signal: AbortSignal.timeout(15000) });
      const value = await response.json() as { error?: unknown };
      if (!response.ok) throw new Error(typeof value.error === 'string' && /^[A-Z0-9_-]{1,100}$/.test(value.error) ? value.error : 'SCRIPT_MANAGEMENT_UNAVAILABLE');
      return value;
    } });
  return client.execute(raw);
}
