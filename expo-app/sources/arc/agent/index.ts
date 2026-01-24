/**
 * Arc Agent Configuration Module
 *
 * Exports everything needed to load and use .arc.yaml configs
 * from agent repositories via RPC.
 */

// Types and schemas
export type {
  ArcConfig,
  AgentDisplay,
  VoiceConfig,
  OrgConfig,
  AgentConfigStatus,
  AgentConfigState,
} from './types';

export {
  ArcConfigSchema,
  AgentDisplaySchema,
  VoiceConfigSchema,
  OrgConfigSchema,
  DEFAULT_AGENT_CONFIG,
  parseArcConfig,
  getAgentDisplayName,
  getAgentAvatarUrl,
  getAgentVoiceId,
} from './types';

// Context provider
export {
  AgentConfigProvider,
  useAgentConfigContext,
  useSessionAgentConfig,
} from './context';

// Hook (for direct usage without context)
export {
  useAgentConfig,
  useAgentDisplayName,
  useAgentVoiceId,
} from './useAgentConfig';

// RPC wiring
export { useAgentConfigRPC } from './useAgentConfigRPC';
