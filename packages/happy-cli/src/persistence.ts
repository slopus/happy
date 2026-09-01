/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { readFile, writeFile, mkdir, open, unlink, rename, stat } from 'node:fs/promises'
import { existsSync, writeFileSync, readFileSync, unlinkSync, renameSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workspaceRoot: z.string().optional(),
  sessionIsolation: z.enum(['strict', 'workspace', 'custom']).default('workspace'),
  customWritePaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default(['~/.ssh', '~/.aws', '~/.gnupg']),
  extraWritePaths: z.array(z.string()).default(['/tmp']),
  denyWritePaths: z.array(z.string()).default(['.env']),
  networkMode: z.enum(['blocked', 'allowed', 'custom']).default('allowed'),
  allowedDomains: z.array(z.string()).default([]),
  deniedDomains: z.array(z.string()).default([]),
  allowLocalBinding: z.boolean().default(true),
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
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state
 */
export interface DaemonLocallyPersistedState {
  pid: number;
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
  ownerToken?: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
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
// Authentication
//

const credentialsSchema = z.object({
  token: z.string(),
  secret: z.string().base64().nullish(), // Legacy
  encryption: z.object({
    publicKey: z.string().base64(),
    machineKey: z.string().base64()
  }).nullish()
})

export type Credentials = {
  token: string,
  encryption: {
    type: 'legacy', secret: Uint8Array
  } | {
    type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array
  }
}

export async function readCredentials(): Promise<Credentials | null> {
  if (!existsSync(configuration.privateKeyFile)) {
    return null
  }
  try {
    const keyBase64 = (await readFile(configuration.privateKeyFile, 'utf8'));
    const credentials = credentialsSchema.parse(JSON.parse(keyBase64));
    if (credentials.secret) {
      return {
        token: credentials.token,
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(Buffer.from(credentials.secret, 'base64'))
        }
      };
    } else if (credentials.encryption) {
      return {
        token: credentials.token,
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(Buffer.from(credentials.encryption.publicKey, 'base64')),
          machineKey: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64'))
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export async function writeCredentialsLegacy(credentials: { secret: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    secret: encodeBase64(credentials.secret),
    token: credentials.token
  }, null, 2));
}

export async function writeCredentialsDataKey(credentials: { publicKey: Uint8Array, machineKey: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    encryption: { publicKey: encodeBase64(credentials.publicKey), machineKey: encodeBase64(credentials.machineKey) },
    token: credentials.token
  }, null, 2));
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile);
  }
}

export async function clearMachineId(): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    machineId: undefined
  }));
}

/**
 * Read daemon state from local file
 */
export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = readDaemonLockObservation();
    if (!before?.owner) {
      return null;
    }

    const isLegacy = before.owner.ownerToken.startsWith('legacy-');
    const stateFile = isLegacy
      ? configuration.daemonStateFile
      : `${configuration.daemonStateFile}.owner.${before.owner.ownerToken}`;

    let content: string;
    try {
      content = await readFile(stateFile, 'utf-8');
    } catch (error: any) {
      const after = readDaemonLockObservation();
      if (after?.generationToken !== before.generationToken) {
        continue;
      }
      if (error?.code !== 'ENOENT') {
        console.error(`[PERSISTENCE] Daemon state file corrupted: ${stateFile}`, error);
      }
      return null;
    }

    const after = readDaemonLockObservation();
    if (after?.generationToken !== before.generationToken) {
      continue;
    }

    try {
      const state = JSON.parse(content) as DaemonLocallyPersistedState;
      if (
        !Number.isSafeInteger(state.pid)
        || state.pid <= 0
        || state.pid !== before.owner.pid
      ) {
        return null;
      }
      if (!isLegacy && state.ownerToken !== before.owner.ownerToken) {
        return null;
      }
      return state;
    } catch (error) {
      console.error(`[PERSISTENCE] Daemon state file corrupted: ${stateFile}`, error);
      return null;
    }
  }

  return null;
}

/**
 * Publish the initial state for one lock generation.
 *
 * New generations never mutate the legacy fixed path. State lives only at the
 * owner-token path selected by the current generation lock.
 */
export function writeDaemonState(
  lockHandle: DaemonLockHandle,
  state: DaemonLocallyPersistedState,
): void {
  writeDaemonGenerationState(lockHandle, state);
}

function writeDaemonGenerationState(
  lockHandle: DaemonLockHandle,
  state: DaemonLocallyPersistedState,
): void {
  const tempPath = `${lockHandle.stateFile}.tmp.${randomUUID()}`;
  try {
    writeFileSync(
      tempPath,
      JSON.stringify({ ...state, pid: lockHandle.pid, ownerToken: lockHandle.ownerToken }, null, 2),
      'utf-8',
    );
    renameSync(tempPath, lockHandle.stateFile);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch { }
  }
}

export interface DaemonLockHandle {
  ownerToken: string;
  pid: number;
  stateFile: string;
  released: boolean;
}

type PersistedDaemonLockOwner = {
  pid: number;
  ownerToken: string;
};

const daemonLockOwnerFile = 'owner.json';
const daemonOwnerTokenPattern = /^[A-Za-z0-9._-]{1,200}$/;

function isSafeDaemonOwnerToken(ownerToken: string): boolean {
  return daemonOwnerTokenPattern.test(ownerToken);
}

type DaemonLockObservation = {
  owner: PersistedDaemonLockOwner | null;
  generationToken: string;
};

function readDaemonLockObservation(): DaemonLockObservation | null {
  try {
    const lockStat = statSync(configuration.daemonLockFile);
    const kind = lockStat.isDirectory() ? 'dir' : 'file';
    const unknownGenerationToken = `unknown-${kind}-${lockStat.dev}-${lockStat.ino}-${lockStat.birthtimeMs}`;

    if (lockStat.isDirectory()) {
      try {
        const owner = JSON.parse(
          readFileSync(join(configuration.daemonLockFile, daemonLockOwnerFile), 'utf-8'),
        ) as PersistedDaemonLockOwner;
        if (
          Number.isSafeInteger(owner.pid)
          && owner.pid > 0
          && isSafeDaemonOwnerToken(owner.ownerToken)
        ) {
          return { owner, generationToken: owner.ownerToken };
        }
      } catch { }
      return { owner: null, generationToken: unknownGenerationToken };
    }

    try {
      // Compatibility with the legacy PID-only lock file. New acquisitions use
      // generation-specific lock directories, but a running older daemon must
      // still block a replacement after an upgrade.
      const pid = Number(readFileSync(configuration.daemonLockFile, 'utf-8').trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        const owner = {
          pid,
          ownerToken: `legacy-${pid}-${lockStat.birthtimeMs}-${lockStat.ino}`,
        };
        return { owner, generationToken: owner.ownerToken };
      }
    } catch { }
    return { owner: null, generationToken: unknownGenerationToken };
  } catch {
    return null;
  }
}

function readDaemonLockOwner(): PersistedDaemonLockOwner | null {
  return readDaemonLockObservation()?.owner ?? null;
}

function daemonLockIsOwnedBy(owner: PersistedDaemonLockOwner): boolean {
  const persistedOwner = readDaemonLockOwner();
  return persistedOwner?.pid === owner.pid && persistedOwner.ownerToken === owner.ownerToken;
}

function retireDaemonLock(ownerToken: string): boolean {
  if (!isSafeDaemonOwnerToken(ownerToken)) {
    return false;
  }
  const retiredPath = `${configuration.daemonLockFile}.retired.${ownerToken}`;
  try {
    // The generation-specific destination is deliberately retained as a
    // tombstone. A delayed operation for this generation then fails instead of
    // renaming or deleting a successor that occupies the shared lock path.
    renameSync(configuration.daemonLockFile, retiredPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh daemon state only while the caller still owns the persisted state.
 * Returns false when a successor daemon has already taken ownership.
 */
export async function writeDaemonStateIfOwned(
  lockHandle: DaemonLockHandle,
  state: DaemonLocallyPersistedState,
): Promise<boolean> {
  if (!daemonLockIsOwnedBy(lockHandle)) {
    return false;
  }

  // Intentional scheduling seam: correctness must survive ownership changing
  // after validation, not merely the ordered-before-call test case.
  await Promise.resolve();
  writeDaemonGenerationState(lockHandle, state);
  return daemonLockIsOwnedBy(lockHandle);
}

/**
 * Retire one daemon generation and remove only its private state. PID-only
 * callers are deliberately ignored because they cannot prove a generation.
 */
export async function clearDaemonState(
  expectedOwner: DaemonLockHandle | DaemonLocallyPersistedState | number,
): Promise<void> {
  if (typeof expectedOwner === 'number') {
    // PID-only cleanup cannot distinguish a reused PID or legacy successor.
    // Leave it for generation-aware acquisition to reclaim once safely stale.
    return;
  }

  const ownerToken = expectedOwner.ownerToken;
  if (!ownerToken || !isSafeDaemonOwnerToken(ownerToken)) {
    return;
  }
  await Promise.resolve();
  retireDaemonLock(ownerToken);

  const ownerStateFile = 'stateFile' in expectedOwner
    ? expectedOwner.stateFile
    : `${configuration.daemonStateFile}.owner.${ownerToken}`;
  try {
    await unlink(ownerStateFile);
  } catch { }
}

/**
 * Destructive reset for isolated Vitest processes only. Production callers
 * must always use generation-scoped cleanup so delayed work remains fenced.
 */
export async function clearDaemonStateForTests(): Promise<void> {
  if (!process.env.VITEST) {
    throw new Error('Unscoped daemon-state cleanup is only available under Vitest');
  }
  try {
    await unlink(configuration.daemonStateFile);
  } catch { }
  try {
    rmSync(configuration.daemonLockFile, { recursive: true, force: true });
  } catch { }
}

/**
 * Acquire an exclusive generation lock for the daemon. Creating the shared
 * directory is the cross-platform no-replace CAS, including against legacy
 * PID files. An ownerless/partial directory is untrusted and never reclaimed.
 */
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<DaemonLockHandle | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ownerToken = randomUUID();
    try {
      // mkdir is atomic and fails when either a legacy file or a generation
      // directory already occupies the shared path. In particular, unlike a
      // Windows directory rename, it cannot replace a legacy PID file that is
      // installed concurrently.
      mkdirSync(configuration.daemonLockFile);
      writeFileSync(
        join(configuration.daemonLockFile, daemonLockOwnerFile),
        JSON.stringify({ pid: process.pid, ownerToken } satisfies PersistedDaemonLockOwner),
        'utf-8',
      );
      // A new generation never uses the legacy fixed-path state. Once this
      // lock is ours, removing a leftover legacy snapshot cannot affect a
      // successor because no successor can acquire the shared lock yet.
      try {
        unlinkSync(configuration.daemonStateFile);
      } catch { }
      return {
        ownerToken,
        pid: process.pid,
        stateFile: `${configuration.daemonStateFile}.owner.${ownerToken}`,
        released: false,
      };
    } catch (error: any) {
      const observation = readDaemonLockObservation();
      const currentOwner = observation?.owner ?? null;
      let lockIsStale = false;
      if (currentOwner && !currentOwner.ownerToken.startsWith('legacy-')) {
        try {
          process.kill(currentOwner.pid, 0);
        } catch (probeError: any) {
          // EPERM (and unknown platform errors) mean the process may still be
          // alive. Only ESRCH is affirmative evidence that the PID is absent.
          lockIsStale = probeError?.code === 'ESRCH';
        }
      }

      if (lockIsStale) {
        const confirmed = readDaemonLockObservation();
        if (
          observation
          && confirmed?.generationToken === observation.generationToken
          && retireDaemonLock(observation.generationToken)
        ) {
          try {
            unlinkSync(`${configuration.daemonStateFile}.owner.${observation.generationToken}`);
          } catch { }
          continue;
        }
      }

      if (attempt === maxAttempts) {
        if (currentOwner?.ownerToken.startsWith('legacy-')) {
          logger.warn(
            `[PERSISTENCE] Refusing to replace legacy daemon lock ${configuration.daemonLockFile} for PID ${currentOwner.pid} without generation proof. Stop the old Happy daemon, or confirm that PID is absent before removing the lock file manually.`,
          );
        } else if (observation && !currentOwner) {
          logger.warn(
            `[PERSISTENCE] Refusing to replace unreadable daemon lock ${configuration.daemonLockFile}; automatic cleanup cannot prove ownership.`,
          );
        }
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/**
 * Release this daemon's lock without deleting a successor's replacement lock.
 */
export async function releaseDaemonLock(lockHandle: DaemonLockHandle): Promise<void> {
  if (lockHandle.released) {
    return;
  }

  await Promise.resolve();
  const retired = retireDaemonLock(lockHandle.ownerToken);
  if (retired || !daemonLockIsOwnedBy(lockHandle)) {
    lockHandle.released = true;
  }
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
};

type SessionsFile = {
  sessions: Record<string, PersistedSession>;
};

const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function readPersistedSessions(): Record<string, PersistedSession> {
  try {
    if (!existsSync(configuration.sessionsFile)) return {};
    const data = JSON.parse(readFileSync(configuration.sessionsFile, 'utf-8')) as SessionsFile;
    if (!data?.sessions || typeof data.sessions !== 'object') return {};

    const now = Date.now();
    const sessions: Record<string, PersistedSession> = {};
    for (const [id, session] of Object.entries(data.sessions)) {
      if (now - session.savedAt < SESSION_MAX_AGE_MS) {
        sessions[id] = session;
      }
    }
    return sessions;
  } catch {
    return {};
  }
}

export function persistSession(sessionId: string, session: PersistedSession): void {
  try {
    const existing = readPersistedSessions();
    existing[sessionId] = session;
    const tmpFile = configuration.sessionsFile + '.tmp';
    writeFileSync(tmpFile, JSON.stringify({ sessions: existing }, null, 2), 'utf-8');
    renameSync(tmpFile, configuration.sessionsFile);
  } catch (error) {
    logger.debug(`[PERSISTENCE] Failed to persist session ${sessionId}:`, error);
  }
}
