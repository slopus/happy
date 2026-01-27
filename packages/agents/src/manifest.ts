import type { AgentCore, AgentId } from './types';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

export const AGENTS_CORE = {
    claude: {
        id: 'claude',
        cliSubcommand: 'claude',
        detectKey: 'claude',
        resume: { vendorResume: 'supported', runtimeGate: null },
    },
    codex: {
        id: 'codex',
        cliSubcommand: 'codex',
        detectKey: 'codex',
        resume: { vendorResume: 'experimental', runtimeGate: null },
    },
    opencode: {
        id: 'opencode',
        cliSubcommand: 'opencode',
        detectKey: 'opencode',
        resume: { vendorResume: 'unsupported', runtimeGate: 'acpLoadSession' },
    },
    gemini: {
        id: 'gemini',
        cliSubcommand: 'gemini',
        detectKey: 'gemini',
        resume: { vendorResume: 'unsupported', runtimeGate: 'acpLoadSession' },
    },
} as const satisfies Record<AgentId, AgentCore>;

