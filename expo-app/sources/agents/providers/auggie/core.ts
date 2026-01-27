import type { AgentCoreConfig } from '@/agents/registryCore';

export const AUGGIE_CORE: AgentCoreConfig = {
    id: 'auggie',
    displayNameKey: 'agentInput.agent.auggie',
    subtitleKey: 'profiles.aiBackend.auggieSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: null,
        name: 'Auggie',
        connectRoute: null,
    },
    flavorAliases: ['auggie'],
    cli: {
        detectKey: 'auggie',
        machineLoginKey: 'auggie',
        installBanner: {
            installKind: 'ifAvailable',
        },
        spawnAgent: 'auggie',
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
        vendorResumeIdField: 'auggieSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.auggieSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.auggieSessionIdCopied',
        supportsVendorResume: false,
        runtimeGate: 'acpLoadSession',
        experimental: false,
    },
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    ui: {
        agentPickerIconName: 'sparkles',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
