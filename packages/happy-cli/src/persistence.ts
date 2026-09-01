/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { readFile, writeFile, mkdir, open, unlink, rename, stat } from 'node:fs/promises'
import { existsSync, writeFileSync, readFileSync, unlinkSync, renameSync, mkdirSync, rmSync, lstatSync, linkSync, readdirSync } from 'node:fs'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
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
    const before = observeDaemonLock();
    if (!before || before.kind === 'invalid') {
      return null;
    }

    let content: string;
    try {
      content = await readFile(configuration.daemonStateFile, 'utf-8');
    } catch (error: any) {
      const after = observeDaemonLock();
      if (!sameObservation(before, after)) {
        continue;
      }
      if (error?.code !== 'ENOENT') {
        console.error(`[PERSISTENCE] Daemon state file corrupted: ${configuration.daemonStateFile}`, error);
      }
      return null;
    }

    const after = observeDaemonLock();
    if (!sameObservation(before, after)) {
      continue;
    }

    try {
      const state = JSON.parse(content) as DaemonLocallyPersistedState;
      if (
        !Number.isSafeInteger(state.pid)
        || state.pid <= 0
        || state.pid !== before.pid
      ) {
        return null;
      }
      if (before.kind === 'generation') {
        if (
          state.ownerToken !== before.ownerToken
          || !sameFile(configuration.daemonStateFile, join(before.path, daemonPrivateStateFile))
        ) {
          return null;
        }
        return state;
      }
      // A PID-only fixed lock is legacy even if its JSON happens to contain an
      // ownerToken copied from a newer generation by an older binary.
      const { ownerToken: _ignored, ...legacyState } = state;
      return legacyState;
    } catch (error) {
      console.error(`[PERSISTENCE] Daemon state file corrupted: ${configuration.daemonStateFile}`, error);
      return null;
    }
  }

  return null;
}

/**
 * Publish immutable private state and expose it through the historical fixed
 * regular-file path. Older CLIs and fixed-path consumers keep seeing exactly
 * the files they understand.
 */
export function writeDaemonState(
  lockHandle: DaemonLockHandle,
  state: DaemonLocallyPersistedState,
): void {
  if (!handleOwnsFixedLock(lockHandle)) {
    throw new Error('Daemon lock ownership changed before state publication');
  }
  const tempPath = join(lockHandle.generationPath, `${daemonPrivateStateFile}.tmp.${randomUUID()}`);
  try {
    writeFileSync(
      tempPath,
      JSON.stringify({ ...state, pid: lockHandle.pid, ownerToken: lockHandle.ownerToken }, null, 2),
      'utf-8',
    );
    renameSync(tempPath, lockHandle.stateFile);
    // The fixed lock still fences successors, so a leftover fixed state belongs
    // to an older completed/partial publication and is safe to replace here.
    try {
      unlinkSync(configuration.daemonStateFile);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    linkSync(lockHandle.stateFile, configuration.daemonStateFile);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch { }
  }
}

export interface DaemonLockHandle {
  ownerToken: string;
  pid: number;
  generationPath: string;
  lockFile: string;
  stateFile: string;
  released: boolean;
}

const daemonPrivateLockFile = 'lock.pid';
const daemonPrivateStateFile = 'state.json';

type DaemonPersistenceTestHooks = {
  beforeGenerationClaim?: (ownerToken: string) => Promise<void> | void;
  beforeOrphanClaim?: (ownerToken: string) => Promise<void> | void;
};

let daemonPersistenceTestHooks: DaemonPersistenceTestHooks = {};

export function setDaemonPersistenceTestHooksForTests(hooks: DaemonPersistenceTestHooks): void {
  if (!process.env.VITEST) {
    throw new Error('Daemon persistence test hooks are only available under Vitest');
  }
  daemonPersistenceTestHooks = hooks;
}

type DaemonLockObservation = {
  identity: string;
  pid: number;
} & ({
  kind: 'legacy';
} | {
  kind: 'generation';
  ownerToken: string;
  path: string;
  phase: 'generation' | 'retiring';
} | {
  kind: 'invalid';
});

function fileIdentity(path: string): string | null {
  try {
    const value = lstatSync(path);
    if (!value.isFile()) return null;
    return `${value.dev}:${value.ino}:${value.birthtimeMs}:${value.size}`;
  } catch {
    return null;
  }
}

function sameFile(left: string, right: string): boolean {
  const leftIdentity = fileIdentity(left);
  return leftIdentity !== null && leftIdentity === fileIdentity(right);
}

function daemonArtifactEntries(): string[] {
  try {
    return readdirSync(dirname(configuration.daemonStateFile));
  } catch {
    return [];
  }
}

function findGenerationForLock(lockPath: string): Extract<DaemonLockObservation, { kind: 'generation' }> | null {
  const stateBase = basename(configuration.daemonStateFile);
  const parent = dirname(configuration.daemonStateFile);
  for (const name of daemonArtifactEntries()) {
    let phase: 'generation' | 'retiring';
    let suffix: string;
    if (name.startsWith(`${stateBase}.generation.`) && !name.endsWith('.tmp')) {
      phase = 'generation';
      suffix = name.slice(`${stateBase}.generation.`.length);
    } else if (name.startsWith(`${stateBase}.retiring.`)) {
      phase = 'retiring';
      suffix = name.slice(`${stateBase}.retiring.`.length);
    } else {
      continue;
    }
    const parts = suffix.split('.');
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ownerToken = parts[1];
    if (!Number.isSafeInteger(pid) || pid <= 0 || !ownerToken) continue;
    const path = join(parent, name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const privateLock = join(path, daemonPrivateLockFile);
    if (sameFile(lockPath, privateLock)) {
      return {
        kind: 'generation',
        identity: fileIdentity(lockPath)!,
        pid,
        ownerToken,
        path,
        phase,
      };
    }
  }
  return null;
}

function observeDaemonLock(): DaemonLockObservation | null {
  try {
    const identity = fileIdentity(configuration.daemonLockFile);
    if (!identity) {
      return existsSync(configuration.daemonLockFile)
        ? { kind: 'invalid', identity: 'non-file', pid: 0 }
        : null;
    }
    const pid = Number(readFileSync(configuration.daemonLockFile, 'utf-8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return { kind: 'invalid', identity, pid: 0 };
    }
    return findGenerationForLock(configuration.daemonLockFile) ?? { kind: 'legacy', identity, pid };
  } catch {
    return null;
  }
}

function sameObservation(before: DaemonLockObservation, after: DaemonLockObservation | null): boolean {
  return after !== null && before.kind === after.kind && before.identity === after.identity && before.pid === after.pid;
}

function handleOwnsFixedLock(handle: DaemonLockHandle): boolean {
  try {
    return !handle.released
      && existsSync(handle.generationPath)
      && sameFile(configuration.daemonLockFile, handle.lockFile)
      && readFileSync(configuration.daemonLockFile, 'utf-8').trim() === String(handle.pid);
  } catch {
    return false;
  }
}

async function claimAndRemoveGeneration(observation: Extract<DaemonLockObservation, { kind: 'generation' }>): Promise<boolean> {
  const retiringPath = join(
    dirname(configuration.daemonStateFile),
    `${basename(configuration.daemonStateFile)}.retiring.${observation.pid}.${observation.ownerToken}.${randomUUID()}`,
  );
  // Every cleanup attempt, including recovery of an already-retiring
  // generation, first renames the exact observed directory to its own unique
  // claim. Only one delayed reclaimer can therefore retain authority over G.
  if (!sameFile(configuration.daemonLockFile, join(observation.path, daemonPrivateLockFile))) return false;
  await daemonPersistenceTestHooks.beforeGenerationClaim?.(observation.ownerToken);
  try {
    renameSync(observation.path, retiringPath);
  } catch {
    return false;
  }

  const privateLock = join(retiringPath, daemonPrivateLockFile);
  if (!sameFile(configuration.daemonLockFile, privateLock)) return false;
  // While this exact private lock still owns the fixed lock, no successor can
  // publish. Any fixed state is either G's state or stale predecessor state
  // left by a crash between fixed-lock publication and state removal.
  if (existsSync(configuration.daemonStateFile)) {
    unlinkSync(configuration.daemonStateFile);
  }
  if (!sameFile(configuration.daemonLockFile, privateLock)) return false;
  unlinkSync(configuration.daemonLockFile);
  rmSync(retiringPath, { recursive: true, force: true });
  return true;
}

function claimAndRemoveLegacy(observation: Extract<DaemonLockObservation, { kind: 'legacy' }>): boolean {
  const fingerprint = observation.identity.replace(/[^A-Za-z0-9._-]/g, '-');
  const claimPath = `${configuration.daemonLockFile}.legacy-claim.${fingerprint}`;
  const guardPath = `${claimPath}.guard`;
  const guardToken = randomUUID();
  let retiredGuardPath: string | null = null;
  try {
    // The deterministic destination is the cleanup CAS: two reclaimers may
    // observe the same dead legacy PID, but only one can create this hard link.
    linkSync(configuration.daemonLockFile, claimPath);
  } catch (error: any) {
    if (error?.code !== 'EEXIST' || !sameFile(configuration.daemonLockFile, claimPath)) {
      return false;
    }
    // Recover a claimant that crashed after publishing the deterministic hard
    // link. A live/ambiguous guard is never stolen; a definitely dead guard is
    // renamed as the recovery CAS before a new guard is installed.
    if (existsSync(guardPath)) {
      try {
        const guard = JSON.parse(readFileSync(guardPath, 'utf-8')) as { pid: number };
        if (!Number.isSafeInteger(guard.pid) || guard.pid <= 0 || !processIsAffirmativelyDead(guard.pid)) {
          return false;
        }
        retiredGuardPath = `${guardPath}.retired.${randomUUID()}`;
        renameSync(guardPath, retiredGuardPath);
      } catch {
        return false;
      }
    }
  }

  try {
    writeFileSync(guardPath, JSON.stringify({ pid: process.pid, token: guardToken }), { flag: 'wx' });
  } catch {
    return false;
  }

  try {
    const confirmed = observeDaemonLock();
    if (
      confirmed?.kind !== 'legacy'
      || confirmed.identity !== observation.identity
      || confirmed.pid !== observation.pid
      || !sameFile(configuration.daemonLockFile, claimPath)
    ) {
      return false;
    }

    if (existsSync(configuration.daemonStateFile)) {
      const stateIdentity = fileIdentity(configuration.daemonStateFile);
      if (!stateIdentity) return false;
      let state: DaemonLocallyPersistedState;
      try {
        state = JSON.parse(readFileSync(configuration.daemonStateFile, 'utf-8')) as DaemonLocallyPersistedState;
      } catch {
        return false;
      }
      if (state.pid !== observation.pid || fileIdentity(configuration.daemonStateFile) !== stateIdentity) {
        return false;
      }
      unlinkSync(configuration.daemonStateFile);
    }

    if (!sameFile(configuration.daemonLockFile, claimPath)) return false;
    unlinkSync(configuration.daemonLockFile);
    return true;
  } finally {
    try {
      const guard = JSON.parse(readFileSync(guardPath, 'utf-8')) as { token?: string };
      if (guard.token === guardToken) unlinkSync(guardPath);
    } catch { }
    try { if (retiredGuardPath) unlinkSync(retiredGuardPath); } catch { }
    if (!existsSync(guardPath)) {
      try { unlinkSync(claimPath); } catch { }
    }
  }
}

function processIsAffirmativelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: any) {
    return error?.code === 'ESRCH';
  }
}

async function garbageCollectDaemonArtifacts(): Promise<void> {
  const stateBase = basename(configuration.daemonStateFile);
  const lockBase = basename(configuration.daemonLockFile);
  const parent = dirname(configuration.daemonStateFile);
  for (const name of daemonArtifactEntries()) {
    if (name.startsWith(`${lockBase}.legacy-claim.`)) {
      // Once the canonical lock is gone, claim/guard links cannot identify an
      // owner and cannot affect a successor. They are safe rollback leftovers.
      if (!existsSync(configuration.daemonLockFile)) {
        try { rmSync(join(parent, name), { force: true }); } catch { }
      }
      continue;
    }
    const match = name.match(new RegExp(`^${stateBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(generation|retiring)\\.(\\d+)\\.(.+?)(\\.tmp)?$`));
    if (!match) continue;
    const pidText = match[2];
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !processIsAffirmativelyDead(pid)) continue;

    const artifactPath = join(parent, name);
    try {
      if (!lstatSync(artifactPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const privateLock = join(artifactPath, daemonPrivateLockFile);
    try {
      if (readFileSync(privateLock, 'utf-8').trim() !== String(pid)) continue;
    } catch {
      if (name.endsWith('.tmp')) {
        // The PID is encoded before mkdir, so even a crash between mkdir and
        // lock.pid publication leaves a temp artifact with a provably dead owner.
        rmSync(artifactPath, { recursive: true, force: true });
      }
      continue;
    }

    const lockAliases = sameFile(configuration.daemonLockFile, privateLock);
    if (lockAliases) {
      // Active fixed ownership is reclaimed through the normal generation CAS,
      // including a retirement that crashed after its directory rename.
      const observation = observeDaemonLock();
      if (observation?.kind === 'generation' && observation.path === artifactPath) {
        await claimAndRemoveGeneration(observation);
      }
      continue;
    }

    const ownerToken = match[3].split('.')[0];
    await daemonPersistenceTestHooks.beforeOrphanClaim?.(ownerToken);
    const claimedPath = join(
      parent,
      `${stateBase}.retiring.${pid}.${ownerToken}.${randomUUID()}`,
    );
    try {
      renameSync(artifactPath, claimedPath);
    } catch {
      continue;
    }
    const claimedLock = join(claimedPath, daemonPrivateLockFile);
    const claimedState = join(claimedPath, daemonPrivateStateFile);
    try {
      // Reserve the fixed lock with G's exact inode before touching fixed
      // state. A concurrently acquired H makes this fail with EEXIST, fencing
      // the collector away from H's state.
      linkSync(claimedLock, configuration.daemonLockFile);
    } catch {
      if (!sameFile(configuration.daemonLockFile, claimedLock)) {
        if (!sameFile(configuration.daemonStateFile, claimedState)) {
          try { rmSync(claimedPath, { recursive: true, force: true }); } catch { }
        }
        continue;
      }
    }
    await claimAndRemoveGeneration({
      kind: 'generation',
      identity: fileIdentity(claimedLock)!,
      pid,
      ownerToken,
      path: claimedPath,
      phase: 'retiring',
    });
  }
}

/**
 * Refresh daemon state only while the caller still owns the persisted state.
 * Returns false when a successor daemon has already taken ownership.
 */
export async function writeDaemonStateIfOwned(
  lockHandle: DaemonLockHandle,
  _state: DaemonLocallyPersistedState,
): Promise<boolean> {
  return handleOwnsFixedLock(lockHandle)
    && sameFile(configuration.daemonStateFile, lockHandle.stateFile);
}

/**
 * Retire one daemon generation. Legacy callers are reclaimed by acquisition
 * only after an affirmative process-death probe and deterministic file claim.
 */
export async function clearDaemonState(
  expectedOwner: DaemonLockHandle | DaemonLocallyPersistedState | number,
): Promise<void> {
  if (typeof expectedOwner === 'number') {
    return;
  }
  const observation = observeDaemonLock();
  if (!observation || observation.kind === 'invalid' || observation.pid !== expectedOwner.pid) {
    return;
  }
  if (observation.kind === 'generation' && expectedOwner.ownerToken === observation.ownerToken) {
    const removed = await claimAndRemoveGeneration(observation);
    if ('released' in expectedOwner && removed) expectedOwner.released = true;
  }
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
  const stateBase = basename(configuration.daemonStateFile);
  const lockBase = basename(configuration.daemonLockFile);
  const parent = dirname(configuration.daemonStateFile);
  for (const name of daemonArtifactEntries()) {
    if (
      name.startsWith(`${stateBase}.generation.`)
      || name.startsWith(`${stateBase}.retiring.`)
      || name.startsWith(`${stateBase}.owner.`)
      || name.startsWith(`${lockBase}.retired.`)
      || name.startsWith(`${lockBase}.legacy-claim.`)
    ) {
      try { rmSync(join(parent, name), { recursive: true, force: true }); } catch { }
    }
  }
}

/**
 * Acquire an exclusive generation lease while preserving the historical fixed
 * PID file. A hard link is the create-if-absent CAS against both old and new
 * binaries; private generation files carry the identity needed for safe cleanup.
 */
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<DaemonLockHandle | null> {
  await garbageCollectDaemonArtifacts();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ownerToken = randomUUID();
    const artifactBase = `${basename(configuration.daemonStateFile)}.generation.${process.pid}.${ownerToken}`;
    const temporaryPath = join(dirname(configuration.daemonStateFile), `${artifactBase}.tmp`);
    const generationPath = join(dirname(configuration.daemonStateFile), artifactBase);
    const privateLock = join(generationPath, daemonPrivateLockFile);
    try {
      mkdirSync(temporaryPath);
      writeFileSync(join(temporaryPath, daemonPrivateLockFile), String(process.pid), 'utf-8');
      renameSync(temporaryPath, generationPath);
      linkSync(privateLock, configuration.daemonLockFile);
      // A predecessor may have crashed after removing its fixed lock but
      // before removing its fixed state. Holding the newly published lock
      // makes this removal safe against both old and new successors.
      try {
        unlinkSync(configuration.daemonStateFile);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return {
        ownerToken,
        pid: process.pid,
        generationPath,
        lockFile: privateLock,
        stateFile: join(generationPath, daemonPrivateStateFile),
        released: false,
      };
    } catch (error: any) {
      try { rmSync(temporaryPath, { recursive: true, force: true }); } catch { }
      if (sameFile(configuration.daemonLockFile, privateLock)) {
        try { unlinkSync(configuration.daemonLockFile); } catch { }
      }
      if (!sameFile(configuration.daemonLockFile, privateLock)) {
        try { rmSync(generationPath, { recursive: true, force: true }); } catch { }
      }
      const observation = observeDaemonLock();
      let ownerIsDead = false;
      if (observation && observation.kind !== 'invalid') {
        try {
          process.kill(observation.pid, 0);
        } catch (probeError: any) {
          ownerIsDead = probeError?.code === 'ESRCH';
        }
      }
      if (ownerIsDead && observation?.kind === 'generation' && await claimAndRemoveGeneration(observation)) {
        continue;
      }
      if (ownerIsDead && observation?.kind === 'legacy' && claimAndRemoveLegacy(observation)) {
        continue;
      }

      if (attempt === maxAttempts) {
        if (observation?.kind === 'legacy') {
          logger.warn(
            `[PERSISTENCE] Refusing to replace legacy daemon lock ${configuration.daemonLockFile} for PID ${observation.pid} without a completed legacy claim.`,
          );
        } else if (observation?.kind === 'invalid') {
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
  const observation = observeDaemonLock();
  if (
    observation?.kind === 'generation'
    && observation.ownerToken === lockHandle.ownerToken
    && await claimAndRemoveGeneration(observation)
  ) {
    lockHandle.released = true;
  } else if (!handleOwnsFixedLock(lockHandle)) {
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
