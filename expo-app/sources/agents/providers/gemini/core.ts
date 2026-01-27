import type { AgentCoreConfig } from '@/agents/registryCore';

export const GEMINI_CORE: AgentCoreConfig = {
    id: 'gemini',
    displayNameKey: 'agentInput.agent.gemini',
    subtitleKey: 'profiles.aiBackend.geminiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.geminiPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: 'gemini',
        name: 'Google Gemini',
        connectRoute: null,
    },
    flavorAliases: ['gemini'],
    cli: {
        detectKey: 'gemini',
        machineLoginKey: 'gemini-cli',
        installBanner: {
            installKind: 'ifAvailable',
            guideUrl: 'https://ai.google.dev/gemini-api/docs/get-started',
        },
        spawnAgent: 'gemini',
    },
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    model: {
        supportsSelection: true,
        defaultMode: 'gemini-2.5-pro',
        allowedModes: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    },
    resume: {
        // Runtime-gated via ACP capability probing (loadSession).
        vendorResumeIdField: 'geminiSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.geminiSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.geminiSessionIdCopied',
        supportsVendorResume: false,
        runtimeGate: 'acpLoadSession',
        experimental: false,
    },
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    ui: {
        agentPickerIconName: 'planet-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 0.88,
    },
};

