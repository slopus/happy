/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { FileHandle } from 'node:fs/promises'
import { readFile, writeFile, mkdir, open, unlink, rename, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';
import { AIBackendProfileSchema, SUPPORTED_SCHEMA_VERSION, validateProfile, type AIBackendProfile } from './persistence/profileSchema';

export * from './persistence/profileSchema';

interface Settings {
  // Schema version for backwards compatibility
  schemaVersion: number
  onboardingCompleted: boolean
  // This ID is used as the actual database ID on the server
  // All machine operations use this ID
  machineId?: string
  machineIdConfirmedByServer?: boolean
  daemonAutoStartWhenRunningHappy?: boolean
  // Profile management settings (synced with happy app)
  activeProfileId?: string
  profiles: AIBackendProfile[]
}

const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  profiles: [],
}

/**
 * Migrate settings from old schema versions to current
 * Always backwards compatible - preserves all data
 */
function migrateSettings(raw: any, fromVersion: number): any {
  let migrated = { ...raw };

  // Migration from v1 to v2 (added profile support)
  if (fromVersion < 2) {
    // Ensure profiles array exists
    if (!migrated.profiles) {
      migrated.profiles = [];
    }
    // Update schema version
    migrated.schemaVersion = 2;
  }

  // Migration from v2 to v3 (removed CLI-local env cache)
  if (fromVersion < 3) {
    if ('localEnvironmentVariables' in migrated) {
      delete migrated.localEnvironmentVariables;
    }
    migrated.schemaVersion = 3;
  }

  // Future migrations go here:
  // if (fromVersion < 4) { ... }

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
  lastHeartbeat?: string;
  daemonLogPath?: string;
}

export const DaemonLocallyPersistedStateSchema = z.object({
  pid: z.number().int().positive(),
  httpPort: z.number().int().positive(),
  startTime: z.string(),
  startedWithCliVersion: z.string(),
  lastHeartbeat: z.string().optional(),
  daemonLogPath: z.string().optional(),
});

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

    // Validate and clean profiles gracefully (don't crash on invalid profiles)
    if (migrated.profiles && Array.isArray(migrated.profiles)) {
      const validProfiles: AIBackendProfile[] = [];
      for (const profile of migrated.profiles) {
        try {
          const validated = AIBackendProfileSchema.parse(profile);
          validProfiles.push(validated);
        } catch (error: any) {
          logger.warn(
            `⚠️ Invalid profile "${profile?.name || profile?.id || 'unknown'}" - skipping. ` +
            `Error: ${error.message}`
          );
          // Continue processing other profiles
        }
      }
      migrated.profiles = validProfiles;
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
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Note: daemon state is written atomically via rename; retry helps if the reader races with filesystem.
      const content = await readFile(configuration.daemonStateFile, 'utf-8');
      const parsed = DaemonLocallyPersistedStateSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        logger.warn(`[PERSISTENCE] Daemon state file is invalid: ${configuration.daemonStateFile}`, parsed.error);
        // File is corrupt/unexpected structure; retry won't help.
        return null;
      }
      return parsed.data;
    } catch (error) {
      // A SyntaxError from JSON.parse indicates the file is corrupt; retrying won't fix it.
      if (error instanceof SyntaxError) {
        logger.warn(`[PERSISTENCE] Daemon state file is corrupt and could not be parsed: ${configuration.daemonStateFile}`, error);
        return null;
      }
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        if (attempt === 3) return null;
        await new Promise((resolve) => setTimeout(resolve, 15));
        continue;
      }
      if (attempt === 3) {
        logger.warn(`[PERSISTENCE] Failed to read daemon state file after 3 attempts: ${configuration.daemonStateFile}`, error);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  return null;
}

/**
 * Write daemon state to local file (synchronously for atomic operation)
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  const dir = dirname(configuration.daemonStateFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${configuration.daemonStateFile}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    try {
      renameSync(tmpPath, configuration.daemonStateFile);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // On Windows, renameSync may fail if destination exists.
      if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
        try {
          unlinkSync(configuration.daemonStateFile);
        } catch {
          // ignore unlink failure (e.g. ENOENT)
        }
        renameSync(tmpPath, configuration.daemonStateFile);
      } else {
        throw e;
      }
    }
  } catch (e) {
    // Best-effort cleanup to avoid leaving behind orphan tmp files on failures like disk full.
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // ignore cleanup failure
    }
    throw e;
  }
}

/**
 * Clean up daemon state file and lock file
 */
export async function clearDaemonState(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    await unlink(configuration.daemonStateFile);
  }
  const tmpPath = `${configuration.daemonStateFile}.tmp`;
  if (existsSync(tmpPath)) {
    await unlink(tmpPath).catch(() => {});
  }
  // Also clean up lock file if it exists (for stale cleanup)
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
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
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
        // Lock file exists, check if process is still running
        try {
          const lockPid = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
          if (lockPid && !isNaN(Number(lockPid))) {
            try {
              process.kill(Number(lockPid), 0); // Check if process exists
            } catch {
              // Process doesn't exist, remove stale lock
              unlinkSync(configuration.daemonLockFile);
              continue; // Retry acquisition
            }
          }
        } catch {
          // Can't read lock file, might be corrupted
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

/**
 * Release daemon lock by closing handle and deleting lock file
 */
export async function releaseDaemonLock(lockHandle: FileHandle): Promise<void> {
  try {
    await lockHandle.close();
  } catch { }

  try {
    if (existsSync(configuration.daemonLockFile)) {
      unlinkSync(configuration.daemonLockFile);
    }
  } catch { }
}

//
// Profile Management
//

/**
 * Get all profiles from settings
 */
export async function getProfiles(): Promise<AIBackendProfile[]> {
  const settings = await readSettings();
  return settings.profiles || [];
}

/**
 * Get a specific profile by ID
 */
export async function getProfile(profileId: string): Promise<AIBackendProfile | null> {
  const settings = await readSettings();
  return settings.profiles.find(p => p.id === profileId) || null;
}

/**
 * Get the active profile
 */
export async function getActiveProfile(): Promise<AIBackendProfile | null> {
  const settings = await readSettings();
  if (!settings.activeProfileId) return null;
  return settings.profiles.find(p => p.id === settings.activeProfileId) || null;
}

/**
 * Set the active profile by ID
 */
export async function setActiveProfile(profileId: string): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    activeProfileId: profileId
  }));
}

/**
 * Update profiles (synced from happy app) with validation
 */
export async function updateProfiles(profiles: unknown[]): Promise<void> {
  // Validate all profiles using Zod schema
  const validatedProfiles = profiles.map(profile => validateProfile(profile));

  await updateSettings(settings => {
    // Preserve active profile ID if it still exists
    const activeProfileId = settings.activeProfileId;
    const activeProfileStillExists = activeProfileId && validatedProfiles.some(p => p.id === activeProfileId);

    return {
      ...settings,
      profiles: validatedProfiles,
      activeProfileId: activeProfileStillExists ? activeProfileId : undefined
    };
  });
}
