import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/storage';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import type { CapabilityId } from '@/sync/capabilitiesProtocol';
import type { Settings } from '@/sync/settings';
import { useUnistyles } from 'react-native-unistyles';

type InstallableDepData = {
    installed: boolean;
    installedVersion: string | null;
    distTag: string;
    lastInstallLogPath: string | null;
    registry?: { ok: true; latestVersion: string | null } | { ok: false; errorMessage: string };
};

type InstallSpecSettingKey = {
    [K in keyof Settings]: Settings[K] extends string | null ? K : never;
}[keyof Settings] & string;

function computeUpdateAvailable(data: InstallableDepData | null): boolean {
    if (!data?.installed) return false;
    const installed = data.installedVersion;
    const latest = data.registry && data.registry.ok ? data.registry.latestVersion : null;
    if (!installed || !latest) return false;
    return installed !== latest;
}

export type InstallableDepInstallerProps = {
    machineId: string;
    enabled: boolean;
    groupTitle: string;
    depId: Extract<CapabilityId, `dep.${string}`>;
    depTitle: string;
    depIconName: React.ComponentProps<typeof Ionicons>['name'];
    depStatus: InstallableDepData | null;
    capabilitiesStatus: 'idle' | 'loading' | 'loaded' | 'error' | 'not-supported';
    installSpecSettingKey: InstallSpecSettingKey;
    installSpecTitle: string;
    installSpecDescription: string;
    installLabels: { install: string; update: string; reinstall: string };
    installModal: { installTitle: string; updateTitle: string; reinstallTitle: string; description: string };
    refreshStatus: () => void;
    refreshRegistry?: () => void;
};

export function InstallableDepInstaller(props: InstallableDepInstallerProps) {
    const { theme } = useUnistyles();
    const [installSpec, setInstallSpec] = useSettingMutable(props.installSpecSettingKey);
    const [isInstalling, setIsInstalling] = React.useState(false);

    if (!props.enabled) return null;

    const updateAvailable = computeUpdateAvailable(props.depStatus);

    const subtitle = (() => {
        if (props.capabilitiesStatus === 'loading') return 'Loading…';
        if (props.capabilitiesStatus === 'not-supported') return 'Not available (update CLI)';
        if (props.capabilitiesStatus === 'error') return 'Error (refresh)';
        if (props.capabilitiesStatus !== 'loaded') return 'Not available';

        if (props.depStatus?.installed) {
            if (updateAvailable) {
                const installedV = props.depStatus.installedVersion ?? 'unknown';
                const latestV = props.depStatus.registry && props.depStatus.registry.ok
                    ? (props.depStatus.registry.latestVersion ?? 'unknown')
                    : 'unknown';
                return `Installed (v${installedV}) — update available (v${latestV})`;
            }
            return `Installed${props.depStatus.installedVersion ? ` (v${props.depStatus.installedVersion})` : ''}`;
        }

        return 'Not installed';
    })();

    const installButtonLabel = props.depStatus?.installed
        ? (updateAvailable ? props.installLabels.update : props.installLabels.reinstall)
        : props.installLabels.install;

    const openInstallSpecPrompt = async () => {
        const next = await Modal.prompt(
            props.installSpecTitle,
            props.installSpecDescription,
            {
                defaultValue: installSpec ?? '',
                placeholder: 'e.g. file:/path/to/pkg or github:owner/repo#branch',
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof next === 'string') {
            setInstallSpec(next);
        }
    };

    const runInstall = async () => {
        const isInstalled = props.depStatus?.installed === true;
        const method = isInstalled ? (updateAvailable ? 'upgrade' : 'install') : 'install';
        const spec = typeof installSpec === 'string' && installSpec.trim().length > 0 ? installSpec.trim() : undefined;

        setIsInstalling(true);
        try {
            const invoke = await machineCapabilitiesInvoke(
                props.machineId,
                {
                    id: props.depId,
                    method,
                    ...(spec ? { params: { installSpec: spec } } : {}),
                },
                { timeoutMs: 5 * 60_000 },
            );
            if (!invoke.supported) {
                Modal.alert(t('common.error'), invoke.reason === 'not-supported' ? t('deps.installNotSupported') : t('deps.installFailed'));
            } else if (!invoke.response.ok) {
                Modal.alert(t('common.error'), invoke.response.error.message);
            } else {
                const logPath = (invoke.response.result as any)?.logPath;
                Modal.alert(t('common.success'), typeof logPath === 'string' ? t('deps.installLog', { path: logPath }) : t('deps.installed'));
            }

            props.refreshStatus();
            props.refreshRegistry?.();
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('deps.installFailed'));
        } finally {
            setIsInstalling(false);
        }
    };

    return (
        <ItemGroup title={props.groupTitle}>
            <Item
                title={props.depTitle}
                subtitle={subtitle}
                icon={<Ionicons name={props.depIconName} size={22} color={theme.colors.textSecondary} />}
                showChevron={false}
                onPress={() => props.refreshRegistry?.()}
            />

            {props.depStatus?.registry && props.depStatus.registry.ok && props.depStatus.registry.latestVersion && (
                <Item
                    title="Latest"
                    subtitle={`${props.depStatus.registry.latestVersion} (tag: ${props.depStatus.distTag})`}
                    icon={<Ionicons name="cloud-download-outline" size={22} color={theme.colors.textSecondary} />}
                    showChevron={false}
                />
            )}

            {props.depStatus?.registry && !props.depStatus.registry.ok && (
                <Item
                    title="Registry check"
                    subtitle={`Failed: ${props.depStatus.registry.errorMessage}`}
                    icon={<Ionicons name="cloud-offline-outline" size={22} color={theme.colors.textSecondary} />}
                    showChevron={false}
                />
            )}

            <Item
                title="Install source"
                subtitle={typeof installSpec === 'string' && installSpec.trim() ? installSpec.trim() : '(default)'}
                icon={<Ionicons name="link-outline" size={22} color={theme.colors.textSecondary} />}
                onPress={openInstallSpecPrompt}
            />

            <Item
                title={installButtonLabel}
                subtitle={props.installModal.description}
                icon={<Ionicons name="download-outline" size={22} color={theme.colors.textSecondary} />}
                disabled={isInstalling || props.capabilitiesStatus === 'loading'}
                onPress={async () => {
                    const alertTitle = props.depStatus?.installed
                        ? (updateAvailable ? props.installModal.updateTitle : props.installModal.reinstallTitle)
                        : props.installModal.installTitle;
                    Modal.alert(
                        alertTitle,
                        props.installModal.description,
                        [
                            { text: t('common.cancel'), style: 'cancel' },
                            { text: installButtonLabel, onPress: runInstall },
                        ],
                    );
                }}
                rightElement={isInstalling ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : undefined}
            />

            {props.depStatus?.lastInstallLogPath && (
                <Item
                    title="Last install log"
                    subtitle={props.depStatus.lastInstallLogPath}
                    icon={<Ionicons name="document-text-outline" size={22} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    onPress={() => Modal.alert('Install log', props.depStatus?.lastInstallLogPath ?? '')}
                />
            )}
        </ItemGroup>
    );
}
