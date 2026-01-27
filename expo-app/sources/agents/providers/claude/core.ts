import type { AgentCoreConfig } from '@/agents/registryCore';

export const CLAUDE_CORE: AgentCoreConfig = {
    id: 'claude',
    displayNameKey: 'agentInput.agent.claude',
    subtitleKey: 'profiles.aiBackend.claudeSubtitle',
    permissionModeI18nPrefix: 'agentInput.permissionMode',
    availability: { experimental: false },
    connectedService: {
        id: 'anthropic',
        name: 'Claude Code',
        connectRoute: '/(app)/settings/connect/claude',
    },
    flavorAliases: ['claude'],
    cli: {
        detectKey: 'claude',
        machineLoginKey: 'claude-code',
        installBanner: {
            installKind: 'command',
            installCommand: 'npm install -g @anthropic-ai/claude-code',
            guideUrl: 'https://docs.anthropic.com/en/docs/claude-code/installation',
        },
        spawnAgent: 'claude',
    },
    permissions: {
        modeGroup: 'claude',
        promptProtocol: 'claude',
    },
    model: {
        supportsSelection: false,
        defaultMode: 'default',
        allowedModes: ['default'],
    },
    resume: {
        vendorResumeIdField: 'claudeSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.claudeCodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.claudeCodeSessionIdCopied',
        supportsVendorResume: true,
        runtimeGate: null,
        experimental: false,
    },
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    ui: {
        agentPickerIconName: 'sparkles-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.14,
    },
};

