import type { AgentCore, AgentId } from './types.js';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

export const AGENTS_CORE = {
    claude: {
        id: 'claude',
        cliSubcommand: 'claude',
        detectKey: 'claude',
        flavorAliases: [],
        cloudConnect: { vendorKey: 'anthropic', status: 'experimental' },
        resume: { vendorResume: 'supported', vendorResumeIdField: null, runtimeGate: null },
    },
    codex: {
        id: 'codex',
        cliSubcommand: 'codex',
        detectKey: 'codex',
        flavorAliases: ['codex-acp', 'codex-mcp'],
        cloudConnect: { vendorKey: 'openai', status: 'experimental' },
        resume: { vendorResume: 'experimental', vendorResumeIdField: 'codexSessionId', runtimeGate: null },
    },
    opencode: {
        id: 'opencode',
        cliSubcommand: 'opencode',
        detectKey: 'opencode',
        flavorAliases: [],
        cloudConnect: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'opencodeSessionId', runtimeGate: 'acpLoadSession' },
    },
    gemini: {
        id: 'gemini',
        cliSubcommand: 'gemini',
        detectKey: 'gemini',
        flavorAliases: [],
        cloudConnect: { vendorKey: 'gemini', status: 'wired' },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'geminiSessionId', runtimeGate: 'acpLoadSession' },
    },
    auggie: {
        id: 'auggie',
        cliSubcommand: 'auggie',
        detectKey: 'auggie',
        flavorAliases: [],
        cloudConnect: null,
        resume: { vendorResume: 'supported', vendorResumeIdField: 'auggieSessionId', runtimeGate: 'acpLoadSession' },
    },
} as const satisfies Record<AgentId, AgentCore>;
