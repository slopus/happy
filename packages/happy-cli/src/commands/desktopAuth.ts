import { constants } from 'node:fs';
import { link, mkdir, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { getDaemonConnectionStatus } from '@/daemon/controlClient';
import { sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';

const MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';
const key = z.string().length(44).refine(value => {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
});
const credentialsSchema = z.object({
  token: z.string().min(1).max(16 * 1024),
  encryption: z.object({ publicKey: key, machineKey: key }).strict(),
}).strict();
const settingsSchema = z.object({ serverUrl: z.string().min(1).max(2048).optional() }).passthrough();
type DesktopCredentials = z.infer<typeof credentialsSchema>;

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Unsupported Happy server URL.');
  }
  return url.toString().replace(/\/+$/, '');
}

/** Bounded, regular-file-only reads; parse errors must never print credential contents. */
async function readJson(path: string): Promise<unknown | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Invalid pairing file.');
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error('Pairing file is too large.');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Cannot read Happy pairing files. Existing credentials were kept.');
  } finally {
    await file?.close();
  }
}

function parseCredentials(raw: unknown): DesktopCredentials {
  const result = credentialsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error('Desktop linking requires valid V2 pairing credentials. Existing credentials were kept.');
  }
  return result.data;
}

async function readServerUrl(path: string): Promise<string | undefined> {
  const raw = await readJson(path);
  const result = settingsSchema.safeParse(raw === undefined ? {} : raw);
  if (!result.success) throw new Error('Invalid Happy server settings. Existing credentials were kept.');
  try {
    return result.data.serverUrl ? normalizeServerUrl(result.data.serverUrl) : undefined;
  } catch {
    throw new Error('Invalid Happy server settings. Existing credentials were kept.');
  }
}

function assertSameAccount(existing: unknown, source: DesktopCredentials): void {
  if (parseCredentials(existing).encryption.publicKey !== source.encryption.publicKey) {
    throw new Error('Desktop and Happy CLI are linked to different accounts. Existing credentials were kept.');
  }
}

/** Reuses the desktop's V2 pairing; never prompts, replaces a login, or exports credentials. */
export async function importDesktopCredentials(): Promise<{ serverUrl: string; machineId: string }> {
  const agentHome = join(configuration.happyHomeDir, 'agent', 'happy');
  const source = parseCredentials(await readJson(join(agentHome, 'access.key')));
  const sourceServer = await readServerUrl(join(agentHome, 'settings.json'));
  // Validate settings strictly before updateSettings's permissive legacy reader can repair them.
  const savedServer = await readServerUrl(configuration.settingsFile);
  // Match the native Agent's precedence, including deliberate environment overrides.
  const nativeServerOverride = process.env.HAPPY_AGENT_HAPPY_SERVER_URL?.trim() || process.env.HAPPY_SERVER_URL?.trim();
  const cliServerOverride = process.env.HAPPY_SERVER_URL?.trim();
  const serverUrl = normalizeServerUrl(nativeServerOverride || sourceServer || savedServer || DEFAULT_SERVER_URL);
  const existing = await readJson(configuration.privateKeyFile);
  const cliServer = normalizeServerUrl(cliServerOverride || savedServer || DEFAULT_SERVER_URL);
  if ((savedServer || existing !== undefined) && cliServer !== serverUrl) {
    throw new Error('Desktop and Happy CLI use different servers. Existing credentials were kept.');
  }
  if (existing !== undefined) assertSameAccount(existing, source);

  await mkdir(configuration.happyHomeDir, { recursive: true, mode: 0o700 });
  // Server affinity is saved before publishing access.key. Re-check inside the settings lock,
  // preserving an ID minted by a concurrent login.
  const settings = await updateSettings(async current => {
    const currentServer = await readServerUrl(configuration.settingsFile);
    const currentCredentials = await readJson(configuration.privateKeyFile);
    if (currentServer && normalizeServerUrl(cliServerOverride || currentServer) !== serverUrl) {
      throw new Error('Desktop and Happy CLI use different servers. Existing credentials were kept.');
    }
    if (currentCredentials !== undefined) assertSameAccount(currentCredentials, source);
    if (current.machineId !== undefined && (typeof current.machineId !== 'string' || !current.machineId.trim())) {
      throw new Error('Invalid Happy CLI machine ID. Existing settings were kept.');
    }
    return { ...current, serverUrl, machineId: current.machineId ?? randomUUID() };
  });

  if (existing === undefined) {
    // Build privately, flush, then publish without replacing an existing target. Opening the
    // final path with "wx" would expose an empty/partial credential file on errors or crashes.
    const temporaryDirectory = await mkdtemp(join(configuration.happyHomeDir, '.desktop-link-'));
    const temporaryKey = join(temporaryDirectory, 'access.key');
    try {
      const file = await open(temporaryKey, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(source, null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporaryKey, configuration.privateKeyFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assertSameAccount(await readJson(configuration.privateKeyFile), source);
      }
    } finally {
      await unlink(temporaryKey).catch(() => {});
      await rmdir(temporaryDirectory).catch(() => {});
    }
  }
  return { serverUrl, machineId: settings.machineId! };
}

export async function handleDesktopAuth(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--check') {
    console.log('happy-desktop-link-v1');
    return;
  }
  if (args.length !== 0) throw new Error('Usage: happy auth desktop [--check]');
  const { serverUrl, machineId } = await importDesktopCredentials();
  // Start-sync replaces an older daemon and preserves its sessions. Do not rely on "daemon
  // start" acknowledging the old local HTTP listener while replacement is in flight.
  const child = spawnHappyCLI(['daemon', 'start-sync'], {
    detached: true,
    env: {
      ...sanitizeSessionEnvironment(process.env),
      HAPPY_SERVER_URL: serverUrl,
      HAPPY_BOOT_AGENT: '0',
      HAPPY_EXPERIMENTAL: '0',
    },
    stdio: 'ignore',
  });
  let failed = false;
  child.once('error', () => { failed = true; });
  child.once('exit', code => { if (code !== 0) failed = true; });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (failed) throw new Error('Happy CLI daemon could not start. Existing pairing was kept.');
    const status = await getDaemonConnectionStatus(Math.min(1000, deadline - Date.now()));
    if (status?.machineId === machineId && status.cliVersion === configuration.currentCliVersion
      && status.serverUrl === serverUrl && status.connected) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Happy CLI is linked but spawn and resume are not online yet. Retry when your connection is available.');
}