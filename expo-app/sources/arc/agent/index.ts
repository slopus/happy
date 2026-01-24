/**
 * Arc Agent Configuration Module
 *
 * Exports everything needed to load and use .arc.yaml configs
 * from agent repositories via RPC.
 */

// Types and schemas
export {
  ArcConfig,
  ArcConfigSchema,
  AgentDisplay,
  AgentDisplaySchema,
  VoiceConfig,
  VoiceConfigSchema,
  OrgConfig,
  OrgConfigSchema,
  AgentConfigStatus,
  AgentConfigState,
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
