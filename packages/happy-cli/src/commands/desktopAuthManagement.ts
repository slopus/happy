import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import tweetnacl from 'tweetnacl';
import { z } from 'zod';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { getDaemonConnectionStatus, type DaemonConnectionStatus } from '@/daemon/controlClient';
import { withCliAuthLock } from '@/utils/authLock';

export type DesktopAuthErrorCode = 'credential_missing' | 'credential_invalid' | 'account_mismatch'
  | 'server_mismatch' | 'identity_changed' | 'daemon_unavailable' | 'daemon_not_ready' | 'unsupported'
  | 'read_failed' | 'reset_failed' | 'machine_delete_failed' | 'invalid_request' | 'auth_busy';
export type DesktopDaemonState = 'stopped' | 'online' | 'offline' | 'unavailable' | 'identity-mismatch' | 'version-mismatch';
type ResetEffects = { localAuthCleared: boolean; registrationRemoved: boolean; daemonStopped: boolean };
export type DesktopAuthStatus = {
  cliVersion: string;
  scope: 'cli-root';
  auth: 'missing' | 'v2' | 'legacy' | 'invalid';
  accountKeyFingerprint: string | null;
  serverUrl: string;
  machineId: string | null;
  identityGuard: string;
  daemon: { state: DesktopDaemonState; connection: DaemonConnectionStatus | null };
  resetPreview: {
    credentialFile: string;
    settingsFile: string;
    settingsFields: ['machineId', 'machineIdConfirmedByServer'];
    registration: { machineId: string; serverUrl: string; accountKeyFingerprint: string } | null;
    stopsDaemon: true;
  };
};
export type DesktopAuthResponse =
  | { version: 1; ok: true; status: DesktopAuthStatus }
  | { version: 1; ok: true; result: ResetEffects }
  | { version: 1; ok: false; error: { code: DesktopAuthErrorCode; message: string } & ResetEffects };

const resetSchema = z.object({
  version: z.literal(1), expectedGuard: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true), removeRegistration: z.boolean(),
}).strict();
export type DesktopAuthResetRequest = z.infer<typeof resetSchema>;
const keySchema = z.string().length(44).refine(value => {
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value;
});
const credentialSchema = z.union([
  z.object({ token: z.string().min(1).max(16384), encryption: z.object({ publicKey: keySchema, machineKey: keySchema }).strict() }).strict(),
  z.object({ token: z.string().min(1).max(16384), secret: keySchema }).strict(),
]);
const machineSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/);
const settingsSchema = z.object({
  schemaVersion: z.number().int().positive().optional(), onboardingCompleted: z.boolean().optional(),
  serverUrl: z.string().max(2048).optional(), machineId: machineSchema.optional(),
  machineIdConfirmedByServer: z.boolean().optional(),
}).passthrough();
const daemonSchema = z.object({ pid: z.number().int().positive(), httpPort: z.number().int().min(1).max(65535) }).passthrough();
const connectionSchema = z.object({
  machineId: machineSchema, cliVersion: z.string().min(1).max(128).regex(/^[\w.+-]+$/),
  serverUrl: z.string().max(2048), connected: z.boolean(),
});
const defaultServer = 'https://api.cluster-fluster.com';

class ManagementError extends Error {
  constructor(readonly code: DesktopAuthErrorCode, message: string) { super(message); }
}
const failure = (code: DesktopAuthErrorCode, message: string): never => { throw new ManagementError(code, message); };

function normalizeServer(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    return failure('read_failed', 'The CLI server setting is invalid.');
  }
}

/** Never follow pairing-file symlinks or print file contents in errors. */
async function readOwnedFile(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536 || (process.getuid && info.uid !== process.getuid())) throw new Error();
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 65536) throw new Error();
    return buffer.subarray(0, size).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return failure('read_failed', 'The CLI pairing files could not be read safely.');
  } finally {
    await file?.close();
  }
}

function parseJson(value: string | null): unknown {
  try { return value === null ? undefined : JSON.parse(value); } catch { return undefined; }
}

async function snapshot() {
  const rawCredentials = await readOwnedFile(configuration.privateKeyFile);
  const rawSettings = await readOwnedFile(configuration.settingsFile);
  const parsedSettings = settingsSchema.safeParse(rawSettings === null ? {} : parseJson(rawSettings));
  if (!parsedSettings.success) return failure('read_failed', 'The CLI settings are invalid.');
  const settings = parsedSettings.data;
  const serverUrl = normalizeServer(process.env.HAPPY_SERVER_URL?.trim() || settings.serverUrl || defaultServer);
  const parsedCredentials = credentialSchema.safeParse(parseJson(rawCredentials));
  const credentials = parsedCredentials.success ? parsedCredentials.data : null;
  const auth: DesktopAuthStatus['auth'] = rawCredentials === null ? 'missing'
    : !credentials ? 'invalid' : 'encryption' in credentials ? 'v2' : 'legacy';
  const publicKey = !credentials ? null : 'encryption' in credentials
    ? Buffer.from(credentials.encryption.publicKey, 'base64')
    : tweetnacl.sign.keyPair.fromSeed(Buffer.from(credentials.secret, 'base64')).publicKey;
  const accountKeyFingerprint = publicKey ? createHash('sha256').update(publicKey).digest('hex') : null;
  const machineId = settings.machineId ?? null;
  const identityGuard = createHash('sha256').update(JSON.stringify({
    scope: 'cli-root', home: configuration.happyHomeDir, credentialFile: configuration.privateKeyFile,
    settingsFile: configuration.settingsFile, rawCredentials, serverUrl, machineId,
    machineIdConfirmedByServer: settings.machineIdConfirmedByServer ?? null,
  })).digest('hex');
  return { auth, accountKeyFingerprint, machineId, serverUrl, identityGuard, credentials, settings };
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    // Permission failures are not proof a process is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function inspectDaemon(identity: Awaited<ReturnType<typeof snapshot>>) {
  const raw = await readOwnedFile(configuration.daemonStateFile);
  if (raw === null) return { state: 'stopped' as DesktopDaemonState, connection: null, process: null };
  const parsed = daemonSchema.safeParse(parseJson(raw));
  if (!parsed.success) return { state: 'unavailable' as DesktopDaemonState, connection: null, process: null };
  if (!isProcessAlive(parsed.data.pid)) return { state: 'stopped' as DesktopDaemonState, connection: null, process: null };
  const response = connectionSchema.safeParse(await getDaemonConnectionStatus(1000));
  if (!response.success) return { state: 'unavailable' as DesktopDaemonState, connection: null, process: parsed.data };
  let serverUrl: string;
  try { serverUrl = normalizeServer(response.data.serverUrl); } catch {
    return { state: 'unavailable' as DesktopDaemonState, connection: null, process: parsed.data };
  }
  const connection = { ...response.data, serverUrl };
  const state: DesktopDaemonState = connection.machineId !== identity.machineId || connection.serverUrl !== identity.serverUrl
    ? 'identity-mismatch' : connection.cliVersion !== configuration.currentCliVersion
      ? 'version-mismatch' : connection.connected ? 'online' : 'offline';
  return { state, connection, process: parsed.data };
}

export async function getDesktopAuthStatus(): Promise<DesktopAuthStatus> {
  const current = await snapshot();
  const daemon = await inspectDaemon(current);
  if ((await snapshot()).identityGuard !== current.identityGuard) return failure('identity_changed', 'The CLI login changed while its status was being checked. Check again.');
  return {
    cliVersion: configuration.currentCliVersion, scope: 'cli-root', auth: current.auth,
    accountKeyFingerprint: current.accountKeyFingerprint, serverUrl: current.serverUrl, machineId: current.machineId,
    identityGuard: current.identityGuard, daemon: { state: daemon.state, connection: daemon.connection },
    resetPreview: {
      credentialFile: configuration.privateKeyFile, settingsFile: configuration.settingsFile,
      settingsFields: ['machineId', 'machineIdConfirmedByServer'], stopsDaemon: true,
      registration: current.machineId && current.accountKeyFingerprint
        ? { machineId: current.machineId, serverUrl: current.serverUrl, accountKeyFingerprint: current.accountKeyFingerprint } : null,
    },
  };
}

async function stopOwnedDaemon(identity: Awaited<ReturnType<typeof snapshot>>, effects: ResetEffects): Promise<void> {
  const daemon = await inspectDaemon(identity);
  if (daemon.state === 'stopped') { effects.daemonStopped = true; return; }
  if (daemon.state === 'unavailable' || daemon.state === 'identity-mismatch' || !daemon.process) {
    return failure('daemon_unavailable', 'The CLI daemon could not be verified. Nothing was removed.');
  }
  // Use the verified listener only. Never signal a PID or fall back to a force kill.
  const state = daemon.process;
  const raw = await readOwnedFile(configuration.daemonStateFile);
  const now = daemonSchema.safeParse(parseJson(raw));
  if (!now.success || now.data.pid !== state.pid || now.data.httpPort !== state.httpPort) {
    return failure('identity_changed', 'The CLI daemon changed. Review its current status before confirming disconnect again.');
  }
  try {
    const response = await fetch(`http://127.0.0.1:${state.httpPort}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1500),
    });
    if (!response.ok || !z.object({ status: z.literal('stopping') }).safeParse(await response.json()).success) throw new Error();
    const deadline = Date.now() + 3000;
    while (isProcessAlive(state.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (isProcessAlive(state.pid)) throw new Error();
    effects.daemonStopped = true;
  } catch {
    return failure('daemon_not_ready', 'The CLI daemon could not be confirmed stopped. Its login was kept.');
  }
}

export async function resetDesktopAuth(request: DesktopAuthResetRequest, effects: ResetEffects): Promise<void> {
  const parsed = resetSchema.safeParse(request);
  if (!parsed.success) return failure('invalid_request', 'Confirm the CLI disconnect and refresh its status before trying again.');
  request = parsed.data;
  await withCliAuthLock(async () => {
    // Validate before the legacy settings reader can follow/repair malformed inputs;
    // the same identity is checked again while the settings lock is held.
    const preview = await snapshot();
    if (preview.identityGuard !== request.expectedGuard) return failure('identity_changed', 'The CLI login changed. Review its current status before confirming disconnect again.');
    await updateSettings(async settings => {
      const current = await snapshot();
      if (current.identityGuard !== request.expectedGuard) return failure('identity_changed', 'The CLI login changed. Review its current status before confirming disconnect again.');
      if (request.removeRegistration && !current.credentials) {
        return failure(current.auth === 'missing' ? 'credential_missing' : 'credential_invalid', 'Valid CLI authentication is needed to remove its computer registration.');
      }
      if (request.removeRegistration && !current.machineId) return failure('invalid_request', 'This CLI has no computer registration to remove.');
      await stopOwnedDaemon(current, effects);
      if (request.removeRegistration) {
        try {
          const response = await fetch(`${current.serverUrl}/v1/machines/${encodeURIComponent(current.machineId!)}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${current.credentials!.token}` },
            signal: AbortSignal.timeout(5000),
          });
          if (response.status === 401) return failure('credential_invalid', 'The server rejected the CLI login. Its local authentication was kept; link again or choose local-only disconnect.');
          // 404 is authoritative: there is no registration for this ID in the current account.
          if (response.status !== 404 && (!response.ok || !z.object({ success: z.literal(true) }).safeParse(await response.json()).success)) throw new Error();
          effects.registrationRemoved = true;
        } catch (error) {
          if (error instanceof ManagementError) throw error;
          return failure('machine_delete_failed', 'Computer removal could not be confirmed. The CLI login was kept; try again when the server is reachable.');
        }
      }
      // Recheck immediately before file mutation even while both auth and settings locks are held.
      if ((await snapshot()).identityGuard !== current.identityGuard) return failure('identity_changed', 'The CLI login changed. Its local authentication was kept.');
      if (current.auth !== 'missing') await unlink(configuration.privateKeyFile);
      effects.localAuthCleared = true;
      const { machineId: _id, machineIdConfirmedByServer: _confirmed, ...remaining } = current.settings;
      // Keep all unrelated persisted fields as they were, including older schema versions.
      return remaining as typeof settings;
    });
  });
}

export async function readDesktopResetRequest(input: Readable): Promise<DesktopAuthResetRequest> {
  const text = await new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
      input.pause();
      if (error) reject(error); else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) finish(new ManagementError('invalid_request', 'The CLI disconnect request is too large.'));
      else chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = () => finish(new ManagementError('invalid_request', 'The CLI disconnect request could not be read.'));
    const timer = setTimeout(() => finish(new ManagementError('invalid_request', 'The CLI disconnect request timed out.')), 5000);
    input.on('data', onData); input.once('end', onEnd); input.once('error', onError);
    input.resume();
  });
  const parsed = resetSchema.safeParse(parseJson(text));
  if (!parsed.success) return failure('invalid_request', 'The CLI disconnect request is invalid. Nothing was removed.');
  return parsed.data;
}

/** Exactly one safe JSON envelope; callers must never render arbitrary stderr as a diagnostic. */
export async function handleDesktopAuthManagement(args: string[], input: Readable = process.stdin): Promise<void> {
  const effects: ResetEffects = { localAuthCleared: false, registrationRemoved: false, daemonStopped: false };
  let result: DesktopAuthResponse;
  try {
    if (args.length !== 1) return failure('invalid_request', 'Use one CLI authentication management operation at a time.');
    if (args[0] === '--status-json') result = { version: 1, ok: true, status: await getDesktopAuthStatus() };
    else if (args[0] === '--reset-json') {
      await resetDesktopAuth(await readDesktopResetRequest(input), effects);
      result = { version: 1, ok: true, result: effects };
    } else return failure('unsupported', 'This CLI authentication management operation is not supported.');
  } catch (error) {
    const code = error instanceof ManagementError ? error.code
      : error instanceof Error && error.message === 'CLI authentication is busy. Try again.' ? 'auth_busy'
        : args.includes('--status-json') ? 'read_failed' : 'reset_failed';
    const message = error instanceof ManagementError ? error.message
      : code === 'auth_busy' ? 'CLI authentication is busy. Try again.'
        : code === 'read_failed' ? 'The CLI status could not be read safely.'
          : 'The CLI disconnect could not finish. Refresh its status before trying again.';
    result = { version: 1, ok: false, error: { code, message, ...effects } };
    process.exitCode = 1;
  }
  console.log(JSON.stringify(result));
}