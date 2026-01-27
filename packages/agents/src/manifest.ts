import type { AgentCore, AgentId } from './types';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

export const AGENTS_CORE = {
    claude: {
        id: 'claude',
        cliSubcommand: 'claude',
        detectKey: 'claude',
        flavorAliases: [],
        resume: { vendorResume: 'supported', vendorResumeIdField: null, runtimeGate: null },
    },
    codex: {
        id: 'codex',
        cliSubcommand: 'codex',
        detectKey: 'codex',
        flavorAliases: ['codex-acp', 'codex-mcp'],
        resume: { vendorResume: 'experimental', vendorResumeIdField: 'codexSessionId', runtimeGate: null },
    },
    opencode: {
        id: 'opencode',
        cliSubcommand: 'opencode',
        detectKey: 'opencode',
        flavorAliases: [],
        resume: { vendorResume: 'supported', vendorResumeIdField: 'opencodeSessionId', runtimeGate: 'acpLoadSession' },
    },
    gemini: {
        id: 'gemini',
        cliSubcommand: 'gemini',
        detectKey: 'gemini',
        flavorAliases: [],
        resume: { vendorResume: 'supported', vendorResumeIdField: 'geminiSessionId', runtimeGate: 'acpLoadSession' },
    },
} as const satisfies Record<AgentId, AgentCore>;
