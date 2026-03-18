import { View, ScrollView, Pressable, Platform, Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Image } from 'expo-image';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useAuth } from '@/auth/AuthContext';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useUnifiedScanner } from '@/hooks/useUnifiedScanner';
import { useLocalSettingMutable, useSetting, useDootaskProfile } from '@/sync/storage';
import { storage } from '@/sync/storage';
import { isUsingCustomServer } from '@/sync/serverConfig';
import { trackWhatsNewClicked } from '@/track';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useHappyAction } from '@/hooks/useHappyAction';
import { getGitHubOAuthParams, disconnectGitHub } from '@/sync/apiGithub';
import { useProfile } from '@/sync/storage';
import { getDisplayName, getAvatarUrl, getBio } from '@/sync/profile';
import { Avatar } from '@/components/Avatar';
import { t } from '@/text';

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const experiments = useSetting('experiments');
    const isCustomServer = isUsingCustomServer();
    const allMachines = useAllMachines();
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);

    const { launchScanner, connectWithUrl, isLoading } = useUnifiedScanner();

    const handleGitHub = async () => {
        const url = 'https://github.com/hitosea/happy-next';
        const supported = await Linking.canOpenURL(url);
        if (supported) {
            await Linking.openURL(url);
        }
    };

    const handleReportIssue = async () => {
        const url = 'https://github.com/hitosea/happy-next/issues';
        const supported = await Linking.canOpenURL(url);
        if (supported) {
            await Linking.openURL(url);
        }
    };

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
    // GitHub connection
    const [connectingGitHub, connectGitHub] = useHappyAction(async () => {
        if (Platform.OS === 'web') {
            const params = await getGitHubOAuthParams(auth.credentials!);
            await Linking.openURL(params.url);
        } else {
            const callbackUrl = 'happy://github-callback';
            const params = await getGitHubOAuthParams(auth.credentials!, callbackUrl);
            await WebBrowser.openAuthSessionAsync(params.url, callbackUrl);
        }
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



    // DooTask connection
    const dootaskProfile = useDootaskProfile();
    const isDootaskConnected = !!dootaskProfile;

    const [connectingDootask, connectDootask] = useHappyAction(async () => {
        router.push('/settings/connect/dootask');
    });

    const [disconnectingDootask, handleDisconnectDootask] = useHappyAction(async () => {
        const confirmed = await Modal.confirm(
            t('dootask.disconnect'),
            t('dootask.disconnectConfirm'),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            if (dootaskProfile) {
                // Fire-and-forget: don't block disconnect on server response
                import('@/sync/dootask/api').then(({ dootaskLogout, deleteDootaskFromServer }) => {
                    dootaskLogout(dootaskProfile.serverUrl, dootaskProfile.token).catch(() => {});
                    deleteDootaskFromServer().catch(() => {});
                });
            }
            storage.getState().clearDootaskData();
        }
    });

    return (

        <ItemList style={{ paddingTop: 0 }}>
            {/* App Info Header */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginTop: 16, borderRadius: 12, marginHorizontal: 16 }}>
                    {profile.firstName ? (
                        // Profile view: Avatar + name + version
                        <>
                            <View style={{ marginBottom: 12 }}>
                                <Avatar
                                    id={profile.id}
                                    size={90}
                                    imageUrl={avatarUrl}
                                    thumbhash={profile.avatar?.thumbhash}
                                />
                            </View>
                            <Text style={{ fontSize: 20, fontWeight: '600', color: theme.colors.text, marginBottom: bio ? 4 : 8 }}>
                                {displayName}
                            </Text>
                            {bio && (
                                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 8, paddingHorizontal: 16 }}>
                                    {bio}
                                </Text>
                            )}
                        </>
                    ) : (
                        // Logo view: Original logo + version
                        <>
                            <Image
                                source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                                contentFit="contain"
                                style={{ width: 300, height: 90, marginBottom: 12 }}
                            />
                        </>
                    )}
                </View>
            </View>

            {/* Connect Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup>
                    <Item
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={launchScanner}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const url = await Modal.prompt(
                                t('modals.scanOrPasteUrl'),
                                t('modals.pasteUrlFromTerminalOrDevice'),
                                {
                                    placeholder: 'happy://...',
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

            <ItemGroup title={t('settings.connectedAccounts')}>
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
                <Item
                    title={t('dootask.title')}
                    subtitle={isDootaskConnected
                        ? t('settings.dootaskConnected', { username: dootaskProfile!.username })
                        : t('settings.connectDootask')
                    }
                    icon={
                        <Image
                            source={require('@/assets/images/icon-dootask-outline.png')}
                            style={{ width: 29, height: 29 }}
                            contentFit="contain"
                        />
                    }
                    onPress={isDootaskConnected ? handleDisconnectDootask : connectDootask}
                    loading={connectingDootask || disconnectingDootask}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Social */}
            {/* <ItemGroup title={t('settings.social')}>
                <Item
                    title={t('navigation.friends')}
                    subtitle={t('friends.manageFriends')}
                    icon={<Ionicons name="people-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/friends')}
                />
            </ItemGroup> */}

            {/* Machines (sorted: online first, then last seen desc) */}
            {allMachines.length > 0 && (
                <ItemGroup title={t('settings.machines')}>
                    {[...allMachines].map((machine) => {
                        const isOnline = isMachineOnline(machine);
                        const host = machine.metadata?.host || 'Unknown';
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
                </ItemGroup>
            )}

            {/* History */}
            <ItemGroup title={t('settings.history')}>
                <Item
                    title={t('sessionHistory.title')}
                    subtitle={t('settings.sessionHistorySubtitle')}
                    icon={<Ionicons name="time-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/session/recent')}
                />
                <Item
                    title={t('agentHistory.title')}
                    subtitle={t('settings.agentHistorySubtitle')}
                    icon={<Ionicons name="albums-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/session/history')}
                />
                <Item
                    title={t('settings.orchestratorRuns')}
                    subtitle={t('settings.orchestratorRunsSubtitle')}
                    icon={<Ionicons name="layers-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/orchestrator')}
                />
            </ItemGroup>

            {/* Features */}
            <ItemGroup title={t('settings.features')}>
                <Item
                    title={t('settings.account')}
                    subtitle={t('settings.accountSubtitle')}
                    icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/account')}
                />
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title={t('settings.voiceAssistant')}
                    subtitle={t('settings.voiceAssistantSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                    onPress={() => router.push('/settings/voice')}
                />
                {Platform.OS !== 'web' && (
                    <Item
                        title={t('settings.notifications')}
                        subtitle={t('settings.notificationsSubtitle')}
                        icon={<Ionicons name="notifications-outline" size={29} color="#FF2D55" />}
                        onPress={() => router.push('/settings/notifications')}
                    />
                )}
                <Item
                    title={t('settings.featuresTitle')}
                    subtitle={t('settings.featuresSubtitle')}
                    icon={<Ionicons name="flask-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/settings/features')}
                />
                <Item
                    title={t('settings.profiles')}
                    subtitle={t('settings.profilesSubtitle')}
                    icon={<Ionicons name="person-outline" size={29} color="#AF52DE" />}
                    onPress={() => router.push('/settings/profiles')}
                />
                {experiments && (
                    <Item
                        title={t('settings.usage')}
                        subtitle={t('settings.usageSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push('/settings/usage')}
                    />
                )}
                <Item
                    title={t('tabs.openclaw')}
                    subtitle={t('settings.openclawSubtitle')}
                    icon={
                        <Image
                            source={require('@/assets/images/brutalist/Brutalism 117.png')}
                            style={{ width: 36, height: 36 }}
                            contentFit="contain"
                            tintColor="#5AC8FA"
                        />
                    }
                    onPress={() => router.push('/openclaw')}
                />
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
                    detail="hitosea/happy-next"
                    onPress={handleGitHub}
                />
                <Item
                    title={t('settings.reportIssue')}
                    icon={<Ionicons name="bug-outline" size={29} color="#FF3B30" />}
                    onPress={handleReportIssue}
                />
                <Item
                    title={t('settings.privacyPolicy')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#007AFF" />}
                    onPress={async () => {
                        const url = 'https://github.com/hitosea/happy-next/blob/next/packages/happy-app/PRIVACY.md';
                        const supported = await Linking.canOpenURL(url);
                        if (supported) {
                            await Linking.openURL(url);
                        }
                    }}
                />
                <Item
                    title={t('settings.termsOfService')}
                    icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                    onPress={async () => {
                        const url = 'https://github.com/hitosea/happy-next/blob/next/packages/happy-app/TERMS.md';
                        const supported = await Linking.canOpenURL(url);
                        if (supported) {
                            await Linking.openURL(url);
                        }
                    }}
                />
                {Platform.OS === 'ios' && (
                    <Item
                        title={t('settings.eula')}
                        icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const url = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
                            const supported = await Linking.canOpenURL(url);
                            if (supported) {
                                await Linking.openURL(url);
                            }
                        }}
                    />
                )}
                <Item
                    title={t('common.version')}
                    detail={appVersion}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={handleVersionClick}
                    showChevron={false}
                />
            </ItemGroup>

        </ItemList>
    );
});
