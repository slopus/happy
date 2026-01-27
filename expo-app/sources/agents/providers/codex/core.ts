import type { AgentCoreConfig } from '@/agents/registryCore';

export const CODEX_CORE: AgentCoreConfig = {
    id: 'codex',
    displayNameKey: 'agentInput.agent.codex',
    subtitleKey: 'profiles.aiBackend.codexSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: false },
    connectedService: {
        id: 'openai',
        name: 'OpenAI Codex',
        connectRoute: null,
    },
    // Persisted metadata has used a few aliases over time.
    flavorAliases: ['codex', 'openai', 'gpt'],
    cli: {
        detectKey: 'codex',
        machineLoginKey: 'codex',
        installBanner: {
            installKind: 'command',
            installCommand: 'npm install -g codex-cli',
            guideUrl: 'https://github.com/openai/openai-codex',
        },
        spawnAgent: 'codex',
    },
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    model: {
        supportsSelection: false,
        defaultMode: 'default',
        allowedModes: ['default'],
    },
    resume: {
        vendorResumeIdField: 'codexSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.codexSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.codexSessionIdCopied',
        supportsVendorResume: true,
        runtimeGate: null,
        experimental: true,
    },
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    ui: {
        agentPickerIconName: 'terminal-outline',
        cliGlyphScale: 0.92,
        profileCompatibilityGlyphScale: 0.82,
    },
};

