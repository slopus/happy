/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { FileHandle } from 'node:fs/promises'
import { readFile, writeFile, mkdir, open, unlink, rename, stat, chmod } from 'node:fs/promises'
import { existsSync, writeFileSync, readFileSync, unlinkSync, renameSync, chmodSync, statSync, lstatSync, openSync, closeSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import type { SaycodeAgentEnvironment } from '@/daemon/sessionEnv';
import { logger } from '@/ui/logger';
import { parseMachineIdentity, type MachineIdentity } from '@/machineIdentity';
import { getProcessStartedAt, getWindowsProcessStartedAt } from '@/utils/processStartTime';

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  workspaceRoot: z.string().optional(),
  sessionIsolation: z.enum(['strict', 'workspace', 'custom']).default('workspace'),
  customWritePaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default(['~/.ssh', '~/.aws', '~/.gnupg']),
  extraWritePaths: z.array(z.string()).default(['/tmp']),
  denyWritePaths: z.array(z.string()).default(['.env']),
  allowGitConfig: z.boolean().optional(),
  networkMode: z.enum(['blocked', 'allowed', 'custom']).default('allowed'),
  allowedDomains: z.array(z.string()).default([]),
  deniedDomains: z.array(z.string()).default([]),
  allowLocalBinding: z.boolean().default(true),
  checkpointProtection: z.object({
    secretPatterns: z.array(z.string()),
    maxFileBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    maxFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    maxTotalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    readOnlyPassthroughPaths: z.array(z.string()).optional(),
  }).strict().optional(),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

// Settings schema version: Integer for overall Settings structure compatibility
// Incremented when Settings structure changes (e.g., adding profiles array was v1→v2)
// Used for migration logic in readSettings()
export const SUPPORTED_SCHEMA_VERSION = 2;

interface Settings {
  schemaVersion: number
  onboardingCompleted: boolean
  machineId?: string
  machineIdConfirmedByServer?: boolean
  daemonAutoStartWhenRunningHappy?: boolean
  chromeMode?: boolean
  sandboxConfig?: SandboxConfig
  serverUrl?: string
  webappUrl?: string
  /** Non-secret endpoint restored when a later CLI invocation restarts the daemon. */
  aplusMcpConfigUrl?: string
  /**
   * aplus §6-1 Phase 3b — aplus claim setup 커맨드가 남기는 계정 box 공개키
   * (base64). 존재하면 legacy 자격증명에 머신 키를 1회 provisioning 한다.
   * 구버전 CLI 는 이 필드를 몰라도 무해하게 보존한다 (plain JSON).
   */
  accountPublicKey?: string
  /**
   * aplus §6-1 트랙 B B1 — aplus claim setup 커맨드가 남기는 서버 서비스
   * box 공개키(base64). 존재하면 머신 등록 시 machineKey 를 서버 몫으로도
   * wrap 한다(이중 수신자). 구버전 CLI 는 이 필드를 몰라도 무해하게 보존.
   */
  serverPublicKey?: string
  /**
   * aplus-dev-studio specs/e2ee-machine-control-boundary — 'strict' keeps the
   * machine key from the server (`happy datakey harden`). Absent is compat.
   * Read through configuration.machineControl.
   */
  machineControl?: 'compat' | 'strict'
}

const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  sandboxConfig: undefined,
}

/**
 * Migrate settings from old schema versions to current
 * Always backwards compatible - preserves all data
 */
function migrateSettings(raw: any, fromVersion: number): any {
  let migrated = { ...raw };

  // Future migrations go here:
  // if (fromVersion < 3) { ... }

  return migrated;
}

/**
 * Serializable subset of TrackedSession for disk persistence
 */
export interface PersistedTrackedSession {
  pid: number;
  /** Absolute launch cwd; present for daemon spawns created by newer clients. */
  directory?: string;
  happySessionId?: string;
  /**
   * Session this child was spawned to resume, recorded at spawn time. Survives
   * a daemon restart so the resume guard still sees a running child that has
   * not reported its session webhook yet.
   */
  resumeTargetSessionId?: string;
  startedBy: string;
  tmuxSessionId?: string;
  startedAt: number;
  /** Tmp HAPPY_HOME_DIR staged for this session, if any. Cleaned on exit. */
  userHomeDir?: string;
  /** Context file awaiting the first explicit user turn. */
  deferredContinuationContextFile?: string;
}

/**
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state.
 * File is preserved on shutdown (state='stopped') for session recovery.
 */
export interface DaemonLocallyPersistedState {
  /** Explicit isolated trial artifact identity; absent for normal releases. */
  windowsCandidateId?: string;
  pid: number;
  /** Verified native creation time; absent in older/non-Windows daemon records. */
  windowsProcessIdentity?: { pid: number; creationFileTime: string };
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
  state?: 'running' | 'stopped' | 'crashed';
  stateReason?: string;
  /*
   * specs/daemon-socket-watchdog/ — `state: 'running'` is true of the process
   * and says nothing about the server link, so a daemon that has held no
   * socket for hours still reads as healthy here. These two record the link
   * itself. Optional: state files written before this field existed still
   * parse, and `undefined` means "this daemon is too old to say", which is
   * not the same as `false`.
   */
  socketConnected?: boolean;
  /** Seconds since the machine socket was last up. Absent while connected. */
  socketDisconnectedSeconds?: number;
  trackedSessions?: PersistedTrackedSession[];
  /**
   * Loopback-only Bearer secret for the control server (ADR-061,
   * specs/desktop-speed-breakthrough-local-direct). Optional so state files
   * written before this field existed still parse; a daemon that started
   * before the auth rollout has no secret and its control server falls back
   * to whatever `controlServer.ts` does for that case.
   */
  controlSecret?: string;
}

export async function readSettings(): Promise<Settings> {
  if (!existsSync(configuration.settingsFile)) {
    return { ...defaultSettings }
  }

  try {
    // Read raw settings
    const content = await readFile(configuration.settingsFile, 'utf8')
    const raw = JSON.parse(content)

    // Check schema version (default to 1 if missing)
    const schemaVersion = raw.schemaVersion ?? 1;

    // Warn if schema version is newer than supported
    if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      logger.warn(
        `⚠️ Settings schema v${schemaVersion} > supported v${SUPPORTED_SCHEMA_VERSION}. ` +
        'Update happy-cli for full functionality.'
      );
    }

    // Migrate if needed
    const migrated = migrateSettings(raw, schemaVersion);

    if (migrated.sandboxConfig !== undefined) {
      try {
        migrated.sandboxConfig = SandboxConfigSchema.parse(migrated.sandboxConfig);
      } catch (error: any) {
        logger.warn(`⚠️ Invalid sandbox config - skipping. Error: ${error.message}`);
        migrated.sandboxConfig = undefined;
      }
    }

    // Merge with defaults to ensure all required fields exist
    return { ...defaultSettings, ...migrated };
  } catch (error: any) {
    logger.warn(`Failed to read settings: ${error.message}`);
    // Return defaults on any error
    return { ...defaultSettings }
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }

  // Ensure schema version is set before writing
  const settingsWithVersion = {
    ...settings,
    schemaVersion: settings.schemaVersion ?? SUPPORTED_SCHEMA_VERSION
  };

  await writeFile(configuration.settingsFile, JSON.stringify(settingsWithVersion, null, 2))
}

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds

  const lockFile = configuration.settingsFile + '.lock';
  const tmpFile = configuration.settingsFile + '.tmp';
  let fileHandle;
  let attempts = 0;

  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY = create exclusively, fail if exists
      fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));

        // Check for stale lock
        try {
          const stats = await stat(lockFile);
          if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => { });
          }
        } catch { }
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new Error(`Failed to acquire settings lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
  }

  try {
    // Read current settings with defaults
    const current = await readSettings() || { ...defaultSettings };

    // Apply update
    const updated = await updater(current);

    // Ensure directory exists
    if (!existsSync(configuration.happyHomeDir)) {
      await mkdir(configuration.happyHomeDir, { recursive: true });
    }

    // Write atomically using rename
    await writeFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, configuration.settingsFile); // Atomic on POSIX

    return updated;
  } finally {
    // Release lock
    await fileHandle.close();
    await unlink(lockFile).catch(() => { }); // Remove lock file
  }
}

//
// Owner-only key material (aplus-dev-studio specs/e2ee-machine-control-boundary R9)
//

/**
 * access.key carries the machine key, its legacy backup the account secret and
 * sessions.json every session's data key. They are owner-only. `mode` on a write
 * only applies when the file is created, so a rewrite of an existing file also
 * resets its mode.
 */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
}

export function writePrivateFileSync(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

/**
 * Brings an existing happy home written before R9 to owner-only. Only the home
 * and the files above, only when they belong to this user, and never through a
 * symlink. Skipped on Windows, where these modes do not mean the same thing.
 */
export function hardenHappyHomePermissions(): void {
  if (process.platform === 'win32') return;
  const targets: Array<[string, number]> = [
    [configuration.happyHomeDir, PRIVATE_DIR_MODE],
    [configuration.privateKeyFile, PRIVATE_FILE_MODE],
    [`${configuration.privateKeyFile}.legacy-backup`, PRIVATE_FILE_MODE],
    [configuration.sessionsFile, PRIVATE_FILE_MODE],
  ];
  const uid = process.getuid?.();
  for (const [path, mode] of targets) {
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || entry.uid !== uid) continue;
      if ((entry.mode & 0o777) !== mode) chmodSync(path, mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug(`[PERSISTENCE] Could not restrict ${path}:`, error);
      }
    }
  }
}

//
// Authentication
//

const credentialsSchema = z.object({
  token: z.string(),
  secret: z.string().base64().nullish(), // Legacy
  encryption: z.object({
    publicKey: z.string().base64(),
    machineKey: z.string().base64(),
    // Read leniently: an unexpected value must not cost the whole credential.
    neverEscrowed: z.boolean().optional()
  }).nullish()
})

export type Credentials = {
  token: string,
  encryption: {
    type: 'legacy', secret: Uint8Array,
    /**
     * aplus §6-1 Phase 3b — legacy 활성 상태에서 병기된 dataKey 재료.
     * RPC 는 여전히 secret(legacy)로 동작하고, 이 재료는 머신 등록 시
     * wrap 된 dataEncryptionKey 를 서버에 올리는 데만 쓰인다. 컷오버
     * (secret 제거 → dataKey 활성)는 별도 phase 의 몫이다.
     */
    provisioned?: { publicKey: Uint8Array, machineKey: Uint8Array }
  } | {
    type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array,
    /**
     * aplus-dev-studio specs/e2ee-machine-control-boundary R4 — set only on a
     * key generated under strict machine control, which the server has never
     * been sent. Absent means the server may hold a copy.
     */
    neverEscrowed?: true
  }
}

/**
 * Pure parsing of the access.key payload. secret-first: a file carrying BOTH
 * secret and encryption parses as legacy-active with the dataKey material
 * attached as `provisioned` — old CLI versions parse the same file as plain
 * legacy (unknown/extra fields are ignored by the schema), so the combined
 * format is backward compatible by construction.
 */
export function parseCredentials(raw: unknown): Credentials | null {
  try {
    const credentials = credentialsSchema.parse(raw);
    if (credentials.secret) {
      const provisioned = credentials.encryption ? {
        publicKey: new Uint8Array(Buffer.from(credentials.encryption.publicKey, 'base64')),
        machineKey: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64'))
      } : undefined;
      return {
        token: credentials.token,
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(Buffer.from(credentials.secret, 'base64')),
          ...(provisioned ? { provisioned } : {})
        }
      };
    } else if (credentials.encryption) {
      return {
        token: credentials.token,
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(Buffer.from(credentials.encryption.publicKey, 'base64')),
          machineKey: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64')),
          ...(credentials.encryption.neverEscrowed === true ? { neverEscrowed: true as const } : {})
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export async function readCredentials(): Promise<Credentials | null> {
  if (!existsSync(configuration.privateKeyFile)) {
    return null
  }
  try {
    const keyBase64 = (await readFile(configuration.privateKeyFile, 'utf8'));
    return parseCredentials(JSON.parse(keyBase64));
  } catch {
    return null
  }
}

/**
 * Serialize a legacy credential with provisioned dataKey material into the
 * combined access.key format (see parseCredentials). Plain object so callers
 * can inspect/persist it.
 */
export function serializeProvisionedLegacyCredentials(input: {
  token: string, secret: Uint8Array, publicKey: Uint8Array, machineKey: Uint8Array
}): { token: string, secret: string, encryption: { publicKey: string, machineKey: string } } {
  return {
    token: input.token,
    secret: encodeBase64(input.secret),
    encryption: {
      publicKey: encodeBase64(input.publicKey),
      machineKey: encodeBase64(input.machineKey)
    }
  };
}

export async function writeCredentialsLegacy(credentials: { secret: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  }
  await writePrivateFile(configuration.privateKeyFile, JSON.stringify({
    secret: encodeBase64(credentials.secret),
    token: credentials.token
  }, null, 2));
}

export async function writeCredentialsDataKey(credentials: { publicKey: Uint8Array, machineKey: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  }
  await writePrivateFile(configuration.privateKeyFile, JSON.stringify({
    encryption: { publicKey: encodeBase64(credentials.publicKey), machineKey: encodeBase64(credentials.machineKey) },
    token: credentials.token
  }, null, 2));
}

/**
 * Replaces access.key with dataKey credentials in one rename, so a crash leaves
 * the old file or the new one and never half of either.
 */
export async function replaceCredentialsDataKey(credentials: {
  publicKey: Uint8Array, machineKey: Uint8Array, token: string, neverEscrowed?: boolean
}): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  }
  const tmp = `${configuration.privateKeyFile}.tmp`
  await writePrivateFile(tmp, JSON.stringify({
    encryption: {
      publicKey: encodeBase64(credentials.publicKey),
      machineKey: encodeBase64(credentials.machineKey),
      ...(credentials.neverEscrowed ? { neverEscrowed: true } : {})
    },
    token: credentials.token
  }, null, 2));
  await rename(tmp, configuration.privateKeyFile);
}

/**
 * Pure assembly for legacy→provisioned upgrade (aplus §6-1 Phase 3b): attach a
 * freshly generated machineKey + the account box publicKey to legacy
 * credentials, and produce the combined access.key payload. Throws on invalid
 * input — callers treat provisioning as best-effort and must not let a throw
 * break startup.
 */
export function buildProvisionedLegacyCredentials(
  credentials: Credentials,
  accountPublicKeyBase64: string,
  machineKey: Uint8Array,
): { updated: Credentials, serialized: ReturnType<typeof serializeProvisionedLegacyCredentials> } {
  if (credentials.encryption.type !== 'legacy') {
    throw new Error('provisioning applies to legacy credentials only');
  }
  if (credentials.encryption.provisioned) {
    throw new Error('credentials already carry provisioned dataKey material');
  }
  const publicKey = new Uint8Array(Buffer.from(accountPublicKeyBase64, 'base64'));
  if (publicKey.length !== 32) {
    throw new Error(`account public key must be 32 bytes, got ${publicKey.length}`);
  }
  if (machineKey.length !== 32) {
    throw new Error(`machine key must be 32 bytes, got ${machineKey.length}`);
  }
  const serialized = serializeProvisionedLegacyCredentials({
    token: credentials.token,
    secret: credentials.encryption.secret,
    publicKey,
    machineKey,
  });
  const updated: Credentials = {
    token: credentials.token,
    encryption: {
      type: 'legacy',
      secret: credentials.encryption.secret,
      provisioned: { publicKey, machineKey },
    },
  };
  return { updated, serialized };
}

/**
 * One-shot machine key provisioning (aplus §6-1 Phase 3b): generate a random
 * machineKey on THIS machine, persist the combined access.key (secret stays
 * active — RPC unchanged), and return the updated credentials. The wrapped
 * key reaches the server via getOrCreateMachine on the next registration.
 */
export async function provisionLegacyMachineKey(
  credentials: Credentials,
  accountPublicKeyBase64: string,
  machineKey: Uint8Array = new Uint8Array(randomBytes(32)),
): Promise<Credentials> {
  const { updated, serialized } = buildProvisionedLegacyCredentials(credentials, accountPublicKeyBase64, machineKey);
  await writePrivateFile(configuration.privateKeyFile, JSON.stringify(serialized, null, 2));
  return updated;
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile);
  }
}

// specs/machine-identity-reuse — survives `auth logout` so the same account comes back as the same machine.
export function machineIdentityFile(): string {
  return join(configuration.happyHomeDir, 'machine-identity.json');
}

export function readMachineIdentity(): MachineIdentity | null {
  try {
    return parseMachineIdentity(JSON.parse(readFileSync(machineIdentityFile(), 'utf8')));
  } catch {
    return null; // Absent or unreadable: behave as before and register a new machine.
  }
}

export function writeMachineIdentity(identity: MachineIdentity): void {
  mkdirSync(configuration.happyHomeDir, { recursive: true });
  writeFileSync(machineIdentityFile(), JSON.stringify(identity, null, 2), { mode: 0o600 });
}

export function clearMachineIdentity(): void {
  rmSync(machineIdentityFile(), { force: true });
}

export async function clearMachineId(): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    machineId: undefined
  }));
}

export interface DaemonStateSnapshot {
  state: DaemonLocallyPersistedState | null;
  /** Exact file contents `state` was parsed from — the token for {@link writeDaemonStateIfUnchanged}. */
  raw: string | null;
}

/**
 * Read daemon state from local file, keeping the raw contents so a caller that
 * wants to write back can first check nobody else changed the file meanwhile.
 */
export async function readDaemonStateSnapshot(): Promise<DaemonStateSnapshot> {
  try {
    if (!existsSync(configuration.daemonStateFile)) {
      return { state: null, raw: null };
    }
    const raw = await readFile(configuration.daemonStateFile, 'utf-8');
    return { state: JSON.parse(raw) as DaemonLocallyPersistedState, raw };
  } catch (error) {
    // State corrupted somehow :(
    console.error(`[PERSISTENCE] Daemon state file corrupted: ${configuration.daemonStateFile}`, error);
    return { state: null, raw: null };
  }
}

/**
 * Read daemon state from local file
 */
export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  return (await readDaemonStateSnapshot()).state;
}

/**
 * Write daemon state to local file (synchronously for atomic operation).
 *
 * Since 2026-09 this file can carry `controlSecret` (ADR-061), so it must be
 * unreadable by other local users. `mode` on `writeFileSync` only applies when
 * the file is newly created — a file that pre-dates this field (or was
 * otherwise created with a looser mode) needs an explicit chmod too.
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  writeFileSync(configuration.daemonStateFile, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  chmodSync(configuration.daemonStateFile, 0o600);
}

/**
 * Compare-and-set write: only writes when the file still holds `expectedRaw`, the
 * contents the caller based its decision on.
 *
 * Needed because several short-lived CLI processes poll the state file while a
 * daemon is starting. Without the guard, a poller that read the previous daemon's
 * dead pid writes it back on top of the state the new daemon just wrote, and the
 * new daemon then sees a foreign pid on its next heartbeat and shuts itself down.
 *
 * @returns true if the write happened, false if someone else owns the file now
 */
export function writeDaemonStateIfUnchanged(expectedRaw: string | null, state: DaemonLocallyPersistedState): boolean {
  const current = existsSync(configuration.daemonStateFile)
    ? readFileSync(configuration.daemonStateFile, 'utf-8')
    : null;
  if (current !== expectedRaw) {
    return false;
  }
  writeDaemonState(state);
  return true;
}

let pendingDaemonState: DaemonLocallyPersistedState | null = null;
let daemonStateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const DAEMON_STATE_DEBOUNCE_MS = 500;

/**
 * Debounced write for daemon state — avoids excessive I/O during rapid session mutations.
 * Call flushDaemonState() before shutdown to ensure final state is written.
 */
export function writeDaemonStateDebounced(state: DaemonLocallyPersistedState): void {
  pendingDaemonState = state;
  if (daemonStateDebounceTimer) {
    clearTimeout(daemonStateDebounceTimer);
  }
  daemonStateDebounceTimer = setTimeout(() => {
    if (pendingDaemonState) {
      writeDaemonState(pendingDaemonState);
    }
    pendingDaemonState = null;
    daemonStateDebounceTimer = null;
  }, DAEMON_STATE_DEBOUNCE_MS);
}

/**
 * Flush any pending debounced daemon state write immediately
 */
export function flushDaemonState(): void {
  if (daemonStateDebounceTimer) {
    clearTimeout(daemonStateDebounceTimer);
    daemonStateDebounceTimer = null;
  }
  if (pendingDaemonState) {
    writeDaemonState(pendingDaemonState);
    pendingDaemonState = null;
  }
}

/**
 * Check if a process with the given PID is alive
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark daemon state as stopped (preserves file for session recovery).
 * Only cleans up lock file, not the state file itself.
 */
export async function clearDaemonState(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    try {
      const content = readFileSync(configuration.daemonStateFile, 'utf-8');
      const current = JSON.parse(content) as DaemonLocallyPersistedState;
      writeDaemonState({ ...current, state: 'stopped' });
    } catch {
      // State corrupted, just remove it
      await unlink(configuration.daemonStateFile);
    }
  }
  if (existsSync(configuration.daemonLockFile)) {
    try {
      await unlink(configuration.daemonLockFile);
    } catch {
      // Lock file might be held by running daemon, ignore error
    }
  }
}

/**
 * Acquire an exclusive lock file for the daemon.
 * The lock file proves the daemon is running and prevents multiple instances.
 * Returns the file handle to hold for the daemon's lifetime, or null if locked.
 */
// A holder writes the lock after it starts, so a pid whose process started
// after the write belongs to someone else. The slack absorbs `ps`'s whole-second
// start times and small clock steps.
const REUSED_LOCK_PID_SLACK_MS = 2_000

export interface DaemonLockDeps {
  /** Epoch ms a live process started, or undefined when it cannot be read. */
  getProcessStartedAt?: (pid: number) => number | undefined | Promise<number | undefined>
  /** Whether the pid is the daemon answering the control port in daemon.state.json. */
  answersAsDaemon?: (pid: number) => Promise<boolean>
}

export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200,
  deps: DaemonLockDeps = {}
): Promise<FileHandle | null> {
  // One verdict per lock observed: a live holder is not re-examined on every retry.
  const verdicts = new Map<string, boolean>();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // O_EXCL ensures we only create if it doesn't exist (atomic lock acquisition)
      const fileHandle = await open(
        configuration.daemonLockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      );
      // Write PID to lock file for debugging
      await fileHandle.writeFile(String(process.pid));
      return fileHandle;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        const seen = readLockSnapshot();
        if (seen) {
          const key = `${seen.raw}:${seen.mtimeMs}:${seen.ino}`;
          let stale = verdicts.get(key);
          if (stale === undefined) {
            stale = await lockHolderIsGone(seen, deps);
            verdicts.set(key, stale);
          }
          if (stale && reclaimLock(seen)) {
            continue; // Retry acquisition
          }
        }
      }

      if (attempt === maxAttempts) {
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

type LockSnapshot = { pid: number; raw: string; mtimeMs: number; ino: number };

function readLockSnapshot(): LockSnapshot | null {
  try {
    const raw = readFileSync(configuration.daemonLockFile, 'utf-8');
    const { mtimeMs, ino } = statSync(configuration.daemonLockFile);
    return /^\d+$/.test(raw.trim()) ? { pid: Number(raw.trim()), raw, mtimeMs, ino } : null;
  } catch {
    return null; // Missing or unreadable: leave it to the next attempt
  }
}

async function lockHolderIsGone(lock: LockSnapshot, deps: DaemonLockDeps): Promise<boolean> {
  try {
    process.kill(lock.pid, 0);
  } catch (error: any) {
    // Only ESRCH proves absence; EPERM is a live process of another account.
    if (error?.code === 'ESRCH') return true;
  }
  // After a logoff or reboot the dead holder's pid can be handed to an unrelated
  // process; an existence check alone would then refuse to start a daemon forever.
  const lookup = deps.getProcessStartedAt
    ?? (process.platform === 'win32' ? getWindowsProcessStartedAt : getProcessStartedAt);
  const startedAt = await lookup(lock.pid);
  if (startedAt === undefined || startedAt <= lock.mtimeMs + REUSED_LOCK_PID_SLACK_MS) return false;
  // A clock step can make a genuine holder look newer than its lock; keep it
  // while it still answers as the daemon.
  return !(await (deps.answersAsDaemon ?? answersAsDaemon)(lock.pid));
}

// Stale tokens older than this belong to a reclaimer that died mid-way.
const RECLAIM_TOKEN_TTL_MS = 30_000;

/**
 * Remove the lock only while it is still the one judged stale. The token makes
 * check-and-unlink exclusive between starters, so one of them cannot delete the
 * fresh lock another has just written.
 */
function reclaimLock(judged: LockSnapshot): boolean {
  const token = `${configuration.daemonLockFile}.reclaim`;
  let fd: number;
  try {
    fd = openSync(token, 'wx');
  } catch {
    try {
      if (Date.now() - statSync(token).mtimeMs > RECLAIM_TOKEN_TTL_MS) unlinkSync(token);
    } catch { }
    return false;
  }
  try {
    const current = readLockSnapshot();
    if (!current || current.raw !== judged.raw || current.mtimeMs !== judged.mtimeMs || current.ino !== judged.ino) return false;
    unlinkSync(configuration.daemonLockFile);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
    try { unlinkSync(token); } catch { }
  }
}

async function answersAsDaemon(pid: number): Promise<boolean> {
  const state = await readDaemonState();
  if (state?.pid !== pid || !state.httpPort) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.controlSecret ? { Authorization: `Bearer ${state.controlSecret}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Pid recorded in daemon.state.json.lock by whoever holds the daemon lock.
 * null when the lock file is missing, unreadable, or holds no integer.
 */
export function readDaemonLockHolderPid(): number | null {
  try {
    const raw = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Release daemon lock by closing handle and deleting lock file
 */
export async function releaseDaemonLock(lockHandle: FileHandle): Promise<void> {
  try {
    await lockHandle.close();
  } catch { }

  try {
    // Never remove a lock another daemon now holds.
    if (readDaemonLockHolderPid() === process.pid) {
      unlinkSync(configuration.daemonLockFile);
    }
  } catch { }
}

// ─── Session persistence (survives daemon restarts) ───

export type PersistedSession = {
  encryptionKey: string;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
  metadata: Metadata;
  savedAt: number;
  /** Staged per-user HAPPY_HOME_DIR — a resume must restore this identity
   *  (2026-07-23 incident: resuming under the daemon account 404s). */
  userHomeDir?: string;
  /** Last message seq the session's child delivered to its agent loop — the
   *  resume skip-baseline. Without it a resume falls back to the server-head
   *  seq and swallows messages that arrived while the session had no process
   *  (2026-08-05 incident). */
  lastProcessedSeq?: number;
  /** Per-session orchestration capability restored after daemon restart. */
  agentEnvironment?: SaycodeAgentEnvironment;
  /** File containing context pending delivery on the first explicit user turn. */
  deferredContinuationContextFile?: string;
};

type SessionsFile = {
  sessions: Record<string, PersistedSession>;
};

export function readPersistedSessions(): Record<string, PersistedSession> {
  try {
    if (!existsSync(configuration.sessionsFile)) return {};
    const data = JSON.parse(readFileSync(configuration.sessionsFile, 'utf-8')) as SessionsFile;
    if (!data?.sessions || typeof data.sessions !== 'object') return {};
    return data.sessions;
  } catch {
    return {};
  }
}

export function persistSession(sessionId: string, session: PersistedSession): void {
  try {
    const existing = readPersistedSessions();
    existing[sessionId] = session;
    const tmpFile = configuration.sessionsFile + '.tmp';
    writePrivateFileSync(tmpFile, JSON.stringify({ sessions: existing }, null, 2));
    renameSync(tmpFile, configuration.sessionsFile);
  } catch (error) {
    logger.debug(`[PERSISTENCE] Failed to persist session ${sessionId}:`, error);
  }
}
