/**
 * Arc Agent Configuration Types
 *
 * Defines the schema for .arc.yaml files that live in agent repositories.
 * These configs are read by the mobile app via RPC to customize display and voice.
 */

import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

// =============================================================================
// .arc.yaml Schema
// =============================================================================

/**
 * Agent display configuration
 */
export const AgentDisplaySchema = z.object({
  /** Display name for the agent (e.g., "Emila") */
  name: z.string(),

  /** Short tagline/description */
  tagline: z.string().optional(),

  /**
   * Avatar URL or "generated" to use Happy's generated avatar.
   * If URL, should be a publicly accessible image.
   */
  avatar: z.union([
    z.string().url(),
    z.literal('generated'),
  ]).optional().default('generated'),

  /**
   * Primary color for theming (hex).
   * Used for accent colors in session view.
   */
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export type AgentDisplay = z.infer<typeof AgentDisplaySchema>;

/**
 * Voice configuration for ElevenLabs
 */
export const VoiceConfigSchema = z.object({
  /** ElevenLabs Conversational Agent ID */
  elevenlabs_agent_id: z.string().optional(),

  /** Custom greeting (overrides agent's default) */
  greeting: z.string().optional(),

  /** Preferred language code */
  language: z.string().optional(),
});

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/**
 * Organization binding (for enterprise features)
 */
export const OrgConfigSchema = z.object({
  /** Organization ID in Runline platform */
  id: z.string(),

  /** Require authentication to access this agent */
  require_auth: z.boolean().optional().default(false),
});

export type OrgConfig = z.infer<typeof OrgConfigSchema>;

/**
 * Complete .arc.yaml schema
 */
export const ArcConfigSchema = z.object({
  /** Agent display settings */
  agent: AgentDisplaySchema.optional(),

  /** Voice configuration */
  voice: VoiceConfigSchema.optional(),

  /** Organization binding (future) */
  org: OrgConfigSchema.optional(),
});

export type ArcConfig = z.infer<typeof ArcConfigSchema>;

// =============================================================================
// Runtime State
// =============================================================================

/**
 * Loading states for agent config
 */
export type AgentConfigStatus =
  | 'idle'           // Not yet attempted
  | 'loading'        // RPC in progress
  | 'loaded'         // Successfully loaded
  | 'not_found'      // No .arc.yaml in repo
  | 'error'          // RPC failed
  | 'timeout';       // RPC timed out

/**
 * Agent config state for a session
 */
export interface AgentConfigState {
  status: AgentConfigStatus;
  config: ArcConfig | null;
  error?: string;
  loadedAt?: number;
}

/**
 * Default config when .arc.yaml is not found
 */
export const DEFAULT_AGENT_CONFIG: ArcConfig = {
  agent: {
    name: '', // Empty = use path-based name
    avatar: 'generated',
  },
};

// =============================================================================
// Utilities
// =============================================================================

/**
 * Parse and validate .arc.yaml content
 */
export function parseArcConfig(content: string): ArcConfig | null {
  try {
    const parsed = parseYaml(content);
    const result = ArcConfigSchema.safeParse(parsed);

    if (result.success) {
      return result.data;
    }

    console.warn('[ArcConfig] Validation failed:', result.error);
    return null;
  } catch (e) {
    console.warn('[ArcConfig] Parse failed:', e);
    return null;
  }
}

/**
 * Get display name from config, with fallback
 */
export function getAgentDisplayName(
  config: ArcConfig | null,
  fallback: string
): string {
  if (config?.agent?.name && config.agent.name.trim() !== '') {
    return config.agent.name;
  }
  return fallback;
}

/**
 * Get avatar URL from config, or null for generated
 */
export function getAgentAvatarUrl(config: ArcConfig | null): string | null {
  if (!config?.agent?.avatar || config.agent.avatar === 'generated') {
    return null;
  }
  return config.agent.avatar;
}

/**
 * Get voice agent ID from config
 */
export function getAgentVoiceId(config: ArcConfig | null): string | null {
  return config?.voice?.elevenlabs_agent_id ?? null;
}
