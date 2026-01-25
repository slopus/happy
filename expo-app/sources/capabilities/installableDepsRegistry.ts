import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/capabilitiesProtocol';
import type { Settings } from '@/sync/settings';
import type { TranslationKey } from '@/text';
import type { CodexAcpDepData } from '@/sync/capabilitiesProtocol';
import type { CodexMcpResumeDepData } from '@/sync/capabilitiesProtocol';
import { t } from '@/text';

import {
    buildCodexMcpResumeRegistryDetectRequest,
    CODEX_MCP_RESUME_DEP_ID,
    getCodexMcpResumeDepData,
    getCodexMcpResumeDetectResult,
    shouldPrefetchCodexMcpResumeRegistry,
} from './codexMcpResume';
import {
    buildCodexAcpRegistryDetectRequest,
    CODEX_ACP_DEP_ID,
    getCodexAcpDepData,
    getCodexAcpDetectResult,
    shouldPrefetchCodexAcpRegistry,
} from './codexAcpDep';

export type InstallSpecSettingKey = {
    [K in keyof Settings]: Settings[K] extends string | null ? K : never;
}[keyof Settings] & string;

export type InstallableDepDataLike = {
    installed: boolean;
    installedVersion: string | null;
    distTag: string;
    lastInstallLogPath: string | null;
    registry?: { ok: true; latestVersion: string | null } | { ok: false; errorMessage: string };
};

export type InstallableDepRegistryEntry = Readonly<{
    key: string;
    experimental: boolean;
    enabledSettingKey: Extract<keyof Settings, string>;
    depId: Extract<CapabilityId, `dep.${string}`>;
    depTitle: string;
    depIconName: string;
    groupTitleKey: TranslationKey;
    installSpecSettingKey: InstallSpecSettingKey;
    installSpecTitle: string;
    installSpecDescription: string;
    installLabels: { installKey: TranslationKey; updateKey: TranslationKey; reinstallKey: TranslationKey };
    installModal: {
        installTitleKey: TranslationKey;
        updateTitleKey: TranslationKey;
        reinstallTitleKey: TranslationKey;
        descriptionKey: TranslationKey;
    };
    getDepStatus: (results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined) => InstallableDepDataLike | null;
    getDetectResult: (results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined) => CapabilityDetectResult | null;
    shouldPrefetchRegistry: (params: {
        requireExistingResult?: boolean;
        result?: CapabilityDetectResult | null;
        data?: InstallableDepDataLike | null;
    }) => boolean;
    buildRegistryDetectRequest: () => CapabilitiesDetectRequest;
}>;

export function getInstallableDepRegistryEntries(): readonly InstallableDepRegistryEntry[] {
    const codexResume: InstallableDepRegistryEntry = {
        key: 'codex-mcp-resume',
        experimental: true,
        enabledSettingKey: 'expCodexResume',
        depId: CODEX_MCP_RESUME_DEP_ID,
        depTitle: t('deps.installable.codexResume.title'),
        depIconName: 'refresh-circle-outline',
        groupTitleKey: 'newSession.codexResumeBanner.title',
        installSpecSettingKey: 'codexResumeInstallSpec',
        installSpecTitle: t('deps.installable.codexResume.installSpecTitle'),
        installSpecDescription: t('deps.installable.installSpecDescription'),
        installLabels: {
            installKey: 'newSession.codexResumeBanner.install',
            updateKey: 'newSession.codexResumeBanner.update',
            reinstallKey: 'newSession.codexResumeBanner.reinstall',
        },
        installModal: {
            installTitleKey: 'newSession.codexResumeInstallModal.installTitle',
            updateTitleKey: 'newSession.codexResumeInstallModal.updateTitle',
            reinstallTitleKey: 'newSession.codexResumeInstallModal.reinstallTitle',
            descriptionKey: 'newSession.codexResumeInstallModal.description',
        },
        getDepStatus: (results) => getCodexMcpResumeDepData(results) as unknown as CodexMcpResumeDepData | null,
        getDetectResult: (results) => getCodexMcpResumeDetectResult(results),
        shouldPrefetchRegistry: ({ requireExistingResult, result, data }) =>
            shouldPrefetchCodexMcpResumeRegistry({
                requireExistingResult,
                result,
                data: data as any,
            }),
        buildRegistryDetectRequest: buildCodexMcpResumeRegistryDetectRequest,
    };

    const codexAcp: InstallableDepRegistryEntry = {
        key: 'codex-acp',
        experimental: true,
        enabledSettingKey: 'expCodexAcp',
        depId: CODEX_ACP_DEP_ID,
        depTitle: t('deps.installable.codexAcp.title'),
        depIconName: 'swap-horizontal-outline',
        groupTitleKey: 'newSession.codexAcpBanner.title',
        installSpecSettingKey: 'codexAcpInstallSpec',
        installSpecTitle: t('deps.installable.codexAcp.installSpecTitle'),
        installSpecDescription: t('deps.installable.installSpecDescription'),
        installLabels: {
            installKey: 'newSession.codexAcpBanner.install',
            updateKey: 'newSession.codexAcpBanner.update',
            reinstallKey: 'newSession.codexAcpBanner.reinstall',
        },
        installModal: {
            installTitleKey: 'newSession.codexAcpInstallModal.installTitle',
            updateTitleKey: 'newSession.codexAcpInstallModal.updateTitle',
            reinstallTitleKey: 'newSession.codexAcpInstallModal.reinstallTitle',
            descriptionKey: 'newSession.codexAcpInstallModal.description',
        },
        getDepStatus: (results) => getCodexAcpDepData(results) as unknown as CodexAcpDepData | null,
        getDetectResult: (results) => getCodexAcpDetectResult(results),
        shouldPrefetchRegistry: ({ requireExistingResult, result, data }) =>
            shouldPrefetchCodexAcpRegistry({
                requireExistingResult,
                result,
                data: data as any,
            }),
        buildRegistryDetectRequest: buildCodexAcpRegistryDetectRequest,
    };

    return [codexResume, codexAcp];
}
