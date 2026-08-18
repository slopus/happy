import { Platform, View } from 'react-native';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { Image } from 'expo-image';
import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useAuth } from '@/auth/AuthContext';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useLocalSettingMutable, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { isUsingCustomServer } from '@/sync/serverConfig';
import { trackWhatsNewClicked } from '@/track';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useUnistyles } from 'react-native-unistyles';
import { useHappyAction } from '@/hooks/useHappyAction';
import { layout } from '@/components/layout';
import { getGitHubOAuthParams, disconnectGitHub } from '@/sync/apiGithub';
import { disconnectService } from '@/sync/apiServices';
import { useProfile } from '@/sync/storage';
import { getDisplayName } from '@/sync/profile';
import { MascotSwitcher } from '@/components/MascotSwitcher';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import * as Localization from 'expo-localization';
import { loadAppConfig } from '@/sync/appConfig';
import { getSettingsFeatureEntries } from '@/components/settingsFeatureEntries';
import { useSettingsRouter } from '@/components/DesktopSettingsNavigation';

type BuildConfig = {
    repositoryUrl?: unknown;
    repositoryIssuesUrl?: unknown;
    buildCommitSha?: unknown;
    buildCommitTimestamp?: unknown;
};

function getBuildConfig(): BuildConfig {
    const appConfig = loadAppConfig();
    return appConfig && typeof appConfig === 'object' ? appConfig as BuildConfig : {};
}

function getGitHubRepoDetail(value: string): string {
    const normalized = value.replace(/\.git$/, '');
    const match = normalized.match(/github\.com\/([^/]+\/[^/#?]+)/i);
    return match ? match[1] : normalized;
}

function formatUtcTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:\d{2}Z$/, 'Z')
        .replace('T', ' ')
        .replace('Z', ' UTC');
}

function formatBuildSubtitle(buildConfig: BuildConfig): string | undefined {
    const commitTimestamp = typeof buildConfig.buildCommitTimestamp === 'string'
        ? formatUtcTimestamp(buildConfig.buildCommitTimestamp)
        : undefined;
    const commitSha = typeof buildConfig.buildCommitSha === 'string'
        ? buildConfig.buildCommitSha.slice(0, 7)
        : undefined;

    if (!commitTimestamp && !commitSha) {
        return undefined;
    }

    return [
        commitTimestamp ? `Commit ${commitTimestamp}` : 'Commit',
        commitSha,
    ].filter(Boolean).join(' / ');
}

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useSettingsRouter();
    const buildConfig = React.useMemo(() => getBuildConfig(), []);
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const runtimeVersion = typeof Constants.expoConfig?.runtimeVersion === 'string'
        ? Constants.expoConfig.runtimeVersion
        : undefined;
    const versionDetail = [
        appVersion,
        runtimeVersion ? `runtime ${runtimeVersion}` : undefined,
    ].filter(Boolean).join(' / ');
    const versionSubtitle = formatBuildSubtitle(buildConfig);
    const auth = useAuth();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    // 「通用」分组：主题/语言入口右侧展示的当前值（响应式，改完返回即更新）
    const [themePreference] = useLocalSettingMutable('themePreference');
    const preferredLanguage = useSetting('preferredLanguage');
    const themeDetailText = themePreference === 'light'
        ? t('settingsAppearance.themeOptions.light')
        : themePreference === 'dark'
            ? t('settingsAppearance.themeOptions.dark')
            : t('settingsAppearance.themeOptions.adaptive');
    // 语言显示文本：与 settings/appearance.tsx 的 getLanguageDisplayText 逻辑一致
    const languageDetailText = React.useMemo(() => {
        if (preferredLanguage === null || preferredLanguage === undefined) {
            const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
            const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
            const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES
                ? getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES)
                : getLanguageNativeName('en');
            return `${t('settingsLanguage.automatic')} (${detectedLanguageName})`;
        }
        if (preferredLanguage in SUPPORTED_LANGUAGES) {
            return getLanguageNativeName(preferredLanguage as keyof typeof SUPPORTED_LANGUAGES);
        }
        return t('settingsLanguage.automatic');
    }, [preferredLanguage]);
    const experiments = useSetting('experiments');
    const isCustomServer = isUsingCustomServer();
    const [showOfflineMachines, setShowOfflineMachines] = React.useState(false);
    const allMachinesWithOffline = useAllMachines({ includeOffline: true });
    const offlineMachineCount = React.useMemo(
        () => allMachinesWithOffline.filter(m => !isMachineOnline(m)).length,
        [allMachinesWithOffline]
    );
    const visibleMachines = React.useMemo(
        () => showOfflineMachines
            ? allMachinesWithOffline
            : allMachinesWithOffline.filter(isMachineOnline),
        [allMachinesWithOffline, showOfflineMachines]
    );
    const profile = useProfile();
    const displayName = getDisplayName(profile);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const repositoryUrl = typeof buildConfig.repositoryUrl === 'string'
        ? buildConfig.repositoryUrl
        : 'https://github.com/wangjs-jacky/happy';
    const repositoryIssuesUrl = typeof buildConfig.repositoryIssuesUrl === 'string'
        ? buildConfig.repositoryIssuesUrl
        : `${repositoryUrl.replace(/\/$/, '')}/issues`;
    const termsUrl = `${repositoryUrl.replace(/\/$/, '').replace(/\.git$/, '')}/blob/main/packages/happy-app/TERMS.md`;
    const repositoryDetail = getGitHubRepoDetail(repositoryUrl);
    const featureEntries = React.useMemo(
        () => getSettingsFeatureEntries({ experiments }),
        [experiments],
    );

    const handleGitHub = async () => {
        await openExternalUrl(repositoryUrl);
    };

    const handleReportIssue = async () => {
        await openExternalUrl(repositoryIssuesUrl);
    };

    // Manual "force update" — a deterministic alternative to the passive update
    // banner. Tapping always yields a result: check → download → confirm → reload,
    // or an explicit "up to date" / error message. Mirrors useUpdates' flow but
    // user-triggered so there's no waiting on the next foreground check.
    const [checkingUpdate, setCheckingUpdate] = React.useState(false);
    const handleCheckUpdate = React.useCallback(async () => {
        if (checkingUpdate) return;
        if (__DEV__) {
            Modal.alert(t('updateBanner.devModeTitle'), t('updateBanner.devModeMessage'));
            return;
        }
        setCheckingUpdate(true);
        try {
            const update = await Updates.checkForUpdateAsync();
            if (!update.isAvailable) {
                Modal.alert(t('updateBanner.upToDateTitle'), t('updateBanner.upToDateMessage'));
                return;
            }
            await Updates.fetchUpdateAsync();
            const confirmed = await Modal.confirm(
                t('updateBanner.readyTitle'),
                t('updateBanner.readyMessage'),
                { confirmText: t('updateBanner.reloadNow'), cancelText: t('common.cancel') },
            );
            if (confirmed) {
                await Updates.reloadAsync();
            }
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        } finally {
            setCheckingUpdate(false);
        }
    }, [checkingUpdate]);

    // Use the multi-click hook for version clicks
    const handleVersionClick = useMultiClick(() => {
        // Toggle dev mode
        const newDevMode = !devModeEnabled;
        setDevModeEnabled(newDevMode);
        Modal.alert(
            t('modals.developerMode'),
            newDevMode ? t('modals.developerModeEnabled') : t('modals.developerModeDisabled')
        );
    }, {
        requiredClicks: 10,
        resetTimeout: 2000
    });

    // Connection status
    const isGitHubConnected = !!profile.github;
    const isAnthropicConnected = profile.connectedServices?.includes('anthropic') || false;

    // GitHub connection
    const [connectingGitHub, connectGitHub] = useHappyAction(async () => {
        const params = await getGitHubOAuthParams(auth.credentials!);
        await openExternalUrl(params.url);
    });

    // GitHub disconnection
    const [disconnectingGitHub, handleDisconnectGitHub] = useHappyAction(async () => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectGithub'),
            t('modals.disconnectGithubConfirm'),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            await disconnectGitHub(auth.credentials!);
        }
    });

    // Anthropic connection
    const [connectingAnthropic, connectAnthropic] = useHappyAction(async () => {
        router.push('/settings/connect/claude');
    });

    // Anthropic disconnection
    const [disconnectingAnthropic, handleDisconnectAnthropic] = useHappyAction(async () => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectService', { service: 'Claude' }),
            t('modals.disconnectServiceConfirm', { service: 'Claude' }),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            await disconnectService(auth.credentials!, 'anthropic');
            await sync.refreshProfile();
        }
    });


    return (

        <ItemList style={{ paddingTop: 0 }}>
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{ alignItems: 'center', paddingVertical: 18, backgroundColor: theme.colors.surface, marginTop: 16, borderRadius: 12, marginHorizontal: 16 }}>
                    <MascotSwitcher />
                </View>
            </View>

            <ItemGroup>
                <Item
                    title={t('settingsAccount.profile')}
                    detail={displayName ?? undefined}
                    icon={<Ionicons name="person-outline" size={29} color={theme.colors.text} />}
                    onPress={() => router.push('/settings/profile' as any)}
                />
                <Item
                    title={t('settings.account')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.text} />}
                    onPress={() => router.push('/settings/account')}
                />
            </ItemGroup>

            {/* Connect Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup>
                    <Item
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color={theme.colors.accent} />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color={theme.colors.accent} />}
                        onPress={async () => {
                            const url = await Modal.prompt(
                                t('modals.authenticateTerminal'),
                                t('modals.pasteUrlFromTerminal'),
                                {
                                    placeholder: 'paws://terminal?...',
                                    confirmText: t('common.authenticate')
                                }
                            );
                            if (url?.trim()) {
                                connectWithUrl(url.trim());
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* General — 主题/语言入口（照图3，列表行 + 右侧当前值） */}
            <ItemGroup title={t('settings.general')}>
                <Item
                    title={t('settings.theme')}
                    icon={<Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />}
                    detail={themeDetailText}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title={t('settings.language')}
                    icon={<Ionicons name="language-outline" size={29} color={theme.colors.accent} />}
                    detail={languageDetailText}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            <ItemGroup title={t('settings.connectedAccounts')}>
                <Item
                    title="Claude Code"
                    subtitle={isAnthropicConnected
                        ? t('settingsAccount.statusActive')
                        : t('settings.connectAccount')
                    }
                    icon={
                        <Image
                            source={require('@/assets/images/icon-claude.png')}
                            style={{ width: 29, height: 29 }}
                            contentFit="contain"
                        />
                    }
                    onPress={isAnthropicConnected ? handleDisconnectAnthropic : connectAnthropic}
                    loading={connectingAnthropic || disconnectingAnthropic}
                    showChevron={false}
                />
                <Item
                    title={t('settings.github')}
                    subtitle={isGitHubConnected
                        ? t('settings.githubConnected', { login: profile.github?.login! })
                        : t('settings.connectGithubAccount')
                    }
                    icon={
                        <Ionicons
                            name="logo-github"
                            size={29}
                            color={isGitHubConnected ? theme.colors.status.connected : theme.colors.textSecondary}
                        />
                    }
                    onPress={isGitHubConnected ? handleDisconnectGitHub : connectGitHub}
                    loading={connectingGitHub || disconnectingGitHub}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Social */}
            {/* <ItemGroup title={t('settings.social')}>
                <Item
                    title={t('navigation.friends')}
                    subtitle={t('friends.manageFriends')}
                    icon={<Ionicons name="people-outline" size={29} color={theme.colors.accent} />}
                    onPress={() => router.push('/friends')}
                />
            </ItemGroup> */}

            {/* Machines (sorted: online first, then last seen desc) */}
            {allMachinesWithOffline.length > 0 && (
                <ItemGroup title={t('settings.machines')}>
                    {visibleMachines.map((machine) => {
                        const isOnline = isMachineOnline(machine);
                        const host = machine.metadata?.host || t('common.unknown');
                        const displayName = machine.metadata?.displayName;
                        const platform = machine.metadata?.platform || '';

                        // Use displayName if available, otherwise use host
                        const title = displayName || host;

                        // Build subtitle: show hostname if different from title, plus platform and status
                        let subtitle = '';
                        if (displayName && displayName !== host) {
                            subtitle = host;
                        }
                        if (platform) {
                            subtitle = subtitle ? `${subtitle} • ${platform}` : platform;
                        }
                        subtitle = subtitle ? `${subtitle} • ${isOnline ? t('status.online') : t('status.offline')}` : (isOnline ? t('status.online') : t('status.offline'));

                        return (
                            <Item
                                key={machine.id}
                                title={title}
                                subtitle={subtitle}
                                icon={
                                    <Ionicons
                                        name="desktop-outline"
                                        size={29}
                                        color={isOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
                                    />
                                }
                                onPress={() => router.push(`/machine/${machine.id}`)}
                            />
                        );
                    })}
                    {offlineMachineCount > 0 && (
                        <Item
                            title={showOfflineMachines
                                ? t('settings.hideOfflineMachines')
                                : t('settings.showOfflineMachines', { count: offlineMachineCount })}
                            onPress={() => setShowOfflineMachines(v => !v)}
                            showChevron={false}
                            titleStyle={{
                                textAlign: 'center',
                                color: theme.colors.textLink,
                            }}
                        />
                    )}
                </ItemGroup>
            )}

            {/* Features */}
            <ItemGroup title={t('settings.features')}>
                {featureEntries.map((entry) => (
                    <Item
                        key={entry.key}
                        title={t(entry.titleKey)}
                        subtitle={t(entry.subtitleKey)}
                        icon={<Ionicons name={entry.icon} size={29} color={entry.color === 'accent' ? theme.colors.accent : entry.color} />}
                        onPress={() => router.push(entry.route as any)}
                    />
                ))}
            </ItemGroup>

            {/* Developer */}
            {(__DEV__ || devModeEnabled) && (
                <ItemGroup title={t('settings.developer')}>
                    <Item
                        title={t('settings.developerTools')}
                        icon={<Ionicons name="construct-outline" size={29} color="#5856D6" />}
                        onPress={() => router.push('/dev')}
                    />
                </ItemGroup>
            )}

            {/* About */}
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                <Item
                    title={t('settings.whatsNew')}
                    subtitle={t('settings.whatsNewSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color="#FF9500" />}
                    onPress={() => {
                        trackWhatsNewClicked();
                        router.push('/changelog');
                    }}
                />
                <Item
                    title={t('settings.github')}
                    icon={<Ionicons name="logo-github" size={29} color={theme.colors.text} />}
                    detail={repositoryDetail}
                    onPress={handleGitHub}
                />
                <Item
                    title={t('settings.reportIssue')}
                    icon={<Ionicons name="bug-outline" size={29} color="#FF3B30" />}
                    onPress={handleReportIssue}
                />
                <Item
                    title={t('settings.privacyPolicy')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.accent} />}
                    onPress={() => openExternalUrl('https://paws.build/privacy/')}
                />
                <Item
                    title={t('settings.termsOfService')}
                    icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accent} />}
                    onPress={() => openExternalUrl(termsUrl)}
                />
                {Platform.OS === 'ios' && (
                    <Item
                        title={t('settings.eula')}
                        icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accent} />}
                        onPress={() => openExternalUrl('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
                    />
                )}
                {Platform.OS !== 'web' && (
                    <Item
                        title={t('updateBanner.forceCheck')}
                        subtitle={checkingUpdate ? t('updateBanner.checking') : t('updateBanner.forceCheckSubtitle')}
                        icon={<Ionicons name="cloud-download-outline" size={29} color="#34C759" />}
                        onPress={handleCheckUpdate}
                        loading={checkingUpdate}
                        showChevron={false}
                    />
                )}
                <Item
                    title={t('common.version')}
                    subtitle={versionSubtitle}
                    subtitleLines={2}
                    detail={versionDetail}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={handleVersionClick}
                    showChevron={false}
                />
            </ItemGroup>

        </ItemList>
    );
});
