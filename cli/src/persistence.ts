/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { FileHandle } from 'node:fs/promises'
import { readFile, writeFile, mkdir, open, unlink, rename, stat } from 'node:fs/promises'
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { constants } from 'node:fs'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';

// AI backend profile schema - MUST match happy app exactly
// Using same Zod schema as GUI for runtime validation consistency

function mergeEnvironmentVariables(
  existing: unknown,
  additions: Record<string, string | undefined>
): Array<{ name: string; value: string }> {
  const map = new Map<string, string>();

  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const name = record.name;
      const value = record.value;
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      map.set(name, value);
    }
  }

  for (const [name, value] of Object.entries(additions)) {
    if (typeof value !== 'string') continue;
    if (!map.has(name)) {
      map.set(name, value);
    }
  }

  return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

function normalizeLegacyProfileConfig(profile: unknown): unknown {
  if (!profile || typeof profile !== 'object') return profile;

  const raw = profile as Record<string, unknown>;

  const readString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  const anthropicConfig = asRecord(raw.anthropicConfig);
  const openaiConfig = asRecord(raw.openaiConfig);
  const azureOpenAIConfig = asRecord(raw.azureOpenAIConfig);
  const togetherAIConfig = asRecord(raw.togetherAIConfig);

  const additions: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: readString(anthropicConfig?.baseUrl),
    ANTHROPIC_AUTH_TOKEN: readString(anthropicConfig?.authToken),
    ANTHROPIC_MODEL: readString(anthropicConfig?.model),
    OPENAI_API_KEY: readString(openaiConfig?.apiKey),
    OPENAI_BASE_URL: readString(openaiConfig?.baseUrl),
    OPENAI_MODEL: readString(openaiConfig?.model),
    AZURE_OPENAI_API_KEY: readString(azureOpenAIConfig?.apiKey),
    AZURE_OPENAI_ENDPOINT: readString(azureOpenAIConfig?.endpoint),
    AZURE_OPENAI_API_VERSION: readString(azureOpenAIConfig?.apiVersion),
    AZURE_OPENAI_DEPLOYMENT_NAME: readString(azureOpenAIConfig?.deploymentName),
    TOGETHER_API_KEY: readString(togetherAIConfig?.apiKey),
    TOGETHER_MODEL: readString(togetherAIConfig?.model),
  };

  const environmentVariables = mergeEnvironmentVariables(raw.environmentVariables, additions);

  // Remove legacy provider config objects. Any values are preserved via environmentVariables migration above.
  const rest: Record<string, unknown> = { ...raw };
  delete rest.anthropicConfig;
  delete rest.openaiConfig;
  delete rest.azureOpenAIConfig;
  delete rest.togetherAIConfig;

  return {
    ...rest,
    environmentVariables,
  };
}

// Tmux configuration schema (matching GUI exactly)
const TmuxConfigSchema = z.object({
    sessionName: z.string().optional(),
    tmpDir: z.string().optional(),
    updateEnvironment: z.boolean().optional(),
});

// Environment variables schema with validation (matching GUI exactly)
const EnvironmentVariableSchema = z.object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Invalid environment variable name'),
    value: z.string(),
});

// Profile compatibility schema (matching GUI exactly)
const ProfileCompatibilitySchema = z.object({
    claude: z.boolean().default(true),
    codex: z.boolean().default(true),
    gemini: z.boolean().default(true),
});

// AIBackendProfile schema - MUST match happy app
export const AIBackendProfileSchema = z.preprocess(normalizeLegacyProfileConfig, z.object({
    // Accept both UUIDs (user profiles) and simple strings (built-in profiles)
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),

    // Tmux configuration
    tmuxConfig: TmuxConfigSchema.optional(),

    // Environment variables (validated)
    environmentVariables: z.array(EnvironmentVariableSchema).default([]),

    // Default session type for this profile
    defaultSessionType: z.enum(['simple', 'worktree']).optional(),

    // Default permission mode for this profile (supports both Claude and Codex modes)
    defaultPermissionMode: z.enum([
        'default', 'acceptEdits', 'bypassPermissions', 'plan',  // Claude modes
        'read-only', 'safe-yolo', 'yolo'  // Codex modes
    ]).optional(),

    // Default model mode for this profile
    defaultModelMode: z.string().optional(),

    // Compatibility metadata
    compatibility: ProfileCompatibilitySchema.default({ claude: true, codex: true, gemini: true }),

    // Built-in profile indicator
    isBuiltIn: z.boolean().default(false),

    // Metadata
    createdAt: z.number().default(() => Date.now()),
    updatedAt: z.number().default(() => Date.now()),
    version: z.string().default('1.0.0'),
}));

export type AIBackendProfile = z.infer<typeof AIBackendProfileSchema>;

// Helper functions matching the happy app exactly
export function validateProfileForAgent(profile: AIBackendProfile, agent: 'claude' | 'codex' | 'gemini'): boolean {
  return profile.compatibility[agent];
}

export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
  const envVars: Record<string, string> = {};

  // Add validated environment variables
  profile.environmentVariables.forEach(envVar => {
    envVars[envVar.name] = envVar.value;
  });

  // Add Tmux config
  if (profile.tmuxConfig) {
    // Empty string means "use current/most recent session", so include it
    if (profile.tmuxConfig.sessionName !== undefined) envVars.TMUX_SESSION_NAME = profile.tmuxConfig.sessionName;
    // Empty string may be valid to use tmux defaults; include if explicitly provided.
    if (profile.tmuxConfig.tmpDir !== undefined) envVars.TMUX_TMPDIR = profile.tmuxConfig.tmpDir;
    if (profile.tmuxConfig.updateEnvironment !== undefined) {
      envVars.TMUX_UPDATE_ENVIRONMENT = profile.tmuxConfig.updateEnvironment.toString();
    }
  }

  return envVars;
}

// Profile validation function using Zod schema
export function validateProfile(profile: unknown): AIBackendProfile {
  const result = AIBackendProfileSchema.safeParse(profile);
  if (!result.success) {
    throw new Error(`Invalid profile data: ${result.error.message}`);
  }
  return result.data;
}


// Profile versioning system
// Profile version: Semver string for individual profile data compatibility (e.g., "1.0.0")
// Used to version the AIBackendProfile schema itself (anthropicConfig, tmuxConfig, etc.)
export const CURRENT_PROFILE_VERSION = '1.0.0';

// Settings schema version: Integer for overall Settings structure compatibility
// Incremented when Settings structure changes (e.g., adding profiles array was v1→v2)
// Used for migration logic in readSettings()
// NOTE: This is the schema for happy-cli's local settings file (not the Happy app's server-synced account settings).
export const SUPPORTED_SCHEMA_VERSION = 3;

// Profile version validation
export function validateProfileVersion(profile: AIBackendProfile): boolean {
  // Simple semver validation for now
  const semverRegex = /^\d+\.\d+\.\d+$/;
  return semverRegex.test(profile.version || '');
}

// Profile compatibility check for version upgrades
export function isProfileVersionCompatible(profileVersion: string, requiredVersion: string = CURRENT_PROFILE_VERSION): boolean {
  // For now, all 1.x.x versions are compatible
  const [major] = profileVersion.split('.');
  const [requiredMajor] = requiredVersion.split('.');
  return major === requiredMajor;
}

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
  try {
    if (!existsSync(configuration.daemonStateFile)) {
      return null;
    }
    const content = await readFile(configuration.daemonStateFile, 'utf-8');
    return JSON.parse(content) as DaemonLocallyPersistedState;
  } catch (error) {
    // State corrupted somehow :(
    console.error(`[PERSISTENCE] Daemon state file corrupted: ${configuration.daemonStateFile}`, error);
    return null;
  }
}

/**
 * Write daemon state to local file (synchronously for atomic operation)
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  writeFileSync(configuration.daemonStateFile, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Clean up daemon state file and lock file
 */
export async function clearDaemonState(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    await unlink(configuration.daemonStateFile);
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
