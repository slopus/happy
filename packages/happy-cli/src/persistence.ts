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

// Environment variable schemas for different AI providers (matching GUI exactly)
const AnthropicConfigSchema = z.object({
    baseUrl: z.string().url().optional(),
    authToken: z.string().optional(),
    model: z.string().optional(),
});

const OpenAIConfigSchema = z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().optional(),
});

const AzureOpenAIConfigSchema = z.object({
    apiKey: z.string().optional(),
    endpoint: z.string().url().optional(),
    apiVersion: z.string().optional(),
    deploymentName: z.string().optional(),
});

const TogetherAIConfigSchema = z.object({
    apiKey: z.string().optional(),
    model: z.string().optional(),
});

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

// AIBackendProfile schema - EXACT MATCH with GUI schema
export const AIBackendProfileSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),

    // Agent-specific configurations
    anthropicConfig: AnthropicConfigSchema.optional(),
    openaiConfig: OpenAIConfigSchema.optional(),
    azureOpenAIConfig: AzureOpenAIConfigSchema.optional(),
    togetherAIConfig: TogetherAIConfigSchema.optional(),

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
});

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

  // Add Anthropic config
  if (profile.anthropicConfig) {
    if (profile.anthropicConfig.baseUrl) envVars.ANTHROPIC_BASE_URL = profile.anthropicConfig.baseUrl;
    if (profile.anthropicConfig.authToken) envVars.ANTHROPIC_AUTH_TOKEN = profile.anthropicConfig.authToken;
    if (profile.anthropicConfig.model) envVars.ANTHROPIC_MODEL = profile.anthropicConfig.model;
  }

  // Add OpenAI config
  if (profile.openaiConfig) {
    if (profile.openaiConfig.apiKey) envVars.OPENAI_API_KEY = profile.openaiConfig.apiKey;
    if (profile.openaiConfig.baseUrl) envVars.OPENAI_BASE_URL = profile.openaiConfig.baseUrl;
    if (profile.openaiConfig.model) envVars.OPENAI_MODEL = profile.openaiConfig.model;
  }

  // Add Azure OpenAI config
  if (profile.azureOpenAIConfig) {
    if (profile.azureOpenAIConfig.apiKey) envVars.AZURE_OPENAI_API_KEY = profile.azureOpenAIConfig.apiKey;
    if (profile.azureOpenAIConfig.endpoint) envVars.AZURE_OPENAI_ENDPOINT = profile.azureOpenAIConfig.endpoint;
    if (profile.azureOpenAIConfig.apiVersion) envVars.AZURE_OPENAI_API_VERSION = profile.azureOpenAIConfig.apiVersion;
    if (profile.azureOpenAIConfig.deploymentName) envVars.AZURE_OPENAI_DEPLOYMENT_NAME = profile.azureOpenAIConfig.deploymentName;
  }

  // Add Together AI config
  if (profile.togetherAIConfig) {
    if (profile.togetherAIConfig.apiKey) envVars.TOGETHER_API_KEY = profile.togetherAIConfig.apiKey;
    if (profile.togetherAIConfig.model) envVars.TOGETHER_MODEL = profile.togetherAIConfig.model;
  }

  // Add Tmux config
  if (profile.tmuxConfig) {
    // Empty string means "use current/most recent session", so include it
    if (profile.tmuxConfig.sessionName !== undefined) envVars.TMUX_SESSION_NAME = profile.tmuxConfig.sessionName;
    if (profile.tmuxConfig.tmpDir) envVars.TMUX_TMPDIR = profile.tmuxConfig.tmpDir;
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
export const SUPPORTED_SCHEMA_VERSION = 2;

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
  chromeMode?: boolean  // Default Chrome mode setting for Claude
  // Profile management settings (synced with happy app)
  activeProfileId?: string
  profiles: AIBackendProfile[]
  sandboxConfig?: SandboxConfig
  // CLI-local environment variable cache (not synced)
  localEnvironmentVariables: Record<string, Record<string, string>> // profileId -> env vars
}

const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  profiles: [],
  sandboxConfig: undefined,
  localEnvironmentVariables: {}
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
    // Ensure localEnvironmentVariables exists
    if (!migrated.localEnvironmentVariables) {
      migrated.localEnvironmentVariables = {};
    }
    // Update schema version
    migrated.schemaVersion = 2;
  }

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

/**
 * Get environment variables for a profile
 * Combines profile custom env vars with CLI-local cached env vars
 */
export async function getEnvironmentVariables(profileId: string): Promise<Record<string, string>> {
  const settings = await readSettings();
  const profile = settings.profiles.find(p => p.id === profileId);
  if (!profile) return {};

  // Start with profile's environment variables (new schema)
  const envVars: Record<string, string> = {};
  if (profile.environmentVariables) {
    profile.environmentVariables.forEach(envVar => {
      envVars[envVar.name] = envVar.value;
    });
  }

  // Override with CLI-local cached environment variables
  const localEnvVars = settings.localEnvironmentVariables[profileId] || {};
  Object.assign(envVars, localEnvVars);

  return envVars;
}

/**
 * Set environment variables for a profile in CLI-local cache
 */
export async function setEnvironmentVariables(profileId: string, envVars: Record<string, string>): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    localEnvironmentVariables: {
      ...settings.localEnvironmentVariables,
      [profileId]: envVars
    }
  }));
}

/**
 * Get a specific environment variable for a profile
 * Checks CLI-local cache first, then profile environment variables
 */
export async function getEnvironmentVariable(profileId: string, key: string): Promise<string | undefined> {
  const settings = await readSettings();

  // Check CLI-local cache first
  const localEnvVars = settings.localEnvironmentVariables[profileId] || {};
  if (localEnvVars[key] !== undefined) {
    return localEnvVars[key];
  }

  // Fall back to profile environment variables (new schema)
  const profile = settings.profiles.find(p => p.id === profileId);
  if (profile?.environmentVariables) {
    const envVar = profile.environmentVariables.find(env => env.name === key);
    if (envVar) {
      return envVar.value;
    }
  }

  return undefined;
}
