import * as z from 'zod';

function mergeEnvironmentVariables(
  existing: unknown,
  additions: Record<string, string | undefined>
): Array<{ name: string; value: string }> {
  /**
   * Merge strategy: preserve explicit `environmentVariables` entries.
   *
   * Legacy provider config objects (e.g. `openaiConfig.apiKey`) are treated as
   * "defaults" and only fill missing keys, so they never override a user-set
   * env var entry that already exists in `environmentVariables`.
   */
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
// Used to version the AIBackendProfile schema itself
export const CURRENT_PROFILE_VERSION = '1.0.0';

// Settings schema version: Integer for overall Settings structure compatibility
// Incremented when Settings structure changes (e.g., adding profiles array was v1→v2)
// Used for migration logic in readSettings()
// NOTE: This is the schema for happy-cli's local settings file (not the Happy app's server-synced account settings).
export const SUPPORTED_SCHEMA_VERSION = 3;

// Profile version validation
export function validateProfileVersion(profile: AIBackendProfile): boolean {
  // Simple semver validation for now
  const semverRegex = /^\\d+\\.\\d+\\.\\d+$/;
  return semverRegex.test(profile.version || '');
}

// Profile compatibility check for version upgrades
export function isProfileVersionCompatible(profileVersion: string, requiredVersion: string = CURRENT_PROFILE_VERSION): boolean {
  // For now, all 1.x.x versions are compatible
  const [major] = profileVersion.split('.');
  const [requiredMajor] = requiredVersion.split('.');
  return major === requiredMajor;
}

