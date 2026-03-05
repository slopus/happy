import { View, ScrollView, Pressable, Platform, Linking } from 'react-native';
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
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useEntitlement, useLocalSettingMutable, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { isUsingCustomServer } from '@/sync/serverConfig';
import { machineStopDaemon } from '@/sync/ops';
import { trackPaywallButtonClicked, trackWhatsNewClicked } from '@/track';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/useMultiClick';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useHappyAction } from '@/hooks/useHappyAction';
import { getGitHubOAuthParams, disconnectGitHub } from '@/sync/apiGithub';
import { disconnectService } from '@/sync/apiServices';
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
    const isPro = __DEV__ || useEntitlement('pro');
    const experiments = useSetting('experiments');
    const isCustomServer = isUsingCustomServer();
    const allMachines = useAllMachines();
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    const handleGitHub = async () => {
        const url = 'https://github.com/slopus/happy';
        const supported = await Linking.canOpenURL(url);
        if (supported) {
            await Linking.openURL(url);
        }
    };

    const handleReportIssue = async () => {
        const url = 'https://github.com/slopus/happy/issues';
        const supported = await Linking.canOpenURL(url);
        if (supported) {
            await Linking.openURL(url);
        }
    };

    const handleSubscribe = async () => {
        trackPaywallButtonClicked();
        const result = await sync.presentPaywall();
        if (!result.success) {
            console.error('Failed to present paywall:', result.error);
        } else if (result.purchased) {
            console.log('Purchase successful!');
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
    const isAnthropicConnected = profile.connectedServices?.includes('anthropic') || false;

    // GitHub connection
    const [connectingGitHub, connectGitHub] = useHappyAction(async () => {
        const params = await getGitHubOAuthParams(auth.credentials!);
        await Linking.openURL(params.url);
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

    // Restart daemon on all online machines
    const [restartingDaemon, handleRestartDaemon] = useHappyAction(async () => {
        const onlineMachines = allMachines.filter(m => isMachineOnline(m));
        if (onlineMachines.length === 0) {
            Modal.alert(t('common.error'), 'No online machines found');
            return;
        }
        const confirmed = await Modal.confirm(
            'Restart Daemon',
            `Restart daemon on ${onlineMachines.length} machine(s)? Active sessions will be recovered automatically.`,
            { confirmText: 'Restart', destructive: true }
        );
        if (!confirmed) return;
        for (const machine of onlineMachines) {
            await machineStopDaemon(machine.id);
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
                        // Logo view: CHATAI.304 branding
                        <View style={{ alignItems: 'flex-start', paddingHorizontal: 16 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#34D399', marginRight: 10 }} />
                                <Text style={[Typography.brand(), { fontSize: 24, letterSpacing: 4, color: theme.colors.text, textTransform: 'uppercase' }]}>
                                    chatai.304
                                </Text>
                            </View>
                            <Text style={[Typography.brand(), { fontSize: 9, letterSpacing: 3, color: theme.colors.textSecondary, marginLeft: 20 }]}>
                                end-to-end. nothing leaks
                            </Text>
                        </View>
                    )}
                </View>
            </View>

            {/* Connect Terminal */}
            <ItemGroup>
                {Platform.OS !== 'web' && (
                    <Item
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                )}
                <Item
                    title={t('connect.enterUrlManually')}
                    icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                    onPress={async () => {
                        const url = await Modal.prompt(
                            t('modals.authenticateTerminal'),
                            t('modals.pasteUrlFromTerminal'),
                            {
                                placeholder: 'happy://terminal?...',
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
                    <Item
                        title="Restart Daemon"
                        subtitle="Stop daemon and recover all sessions"
                        icon={
                            <Ionicons
                                name="refresh-outline"
                                size={29}
                                color={theme.colors.status.warning || '#FF9500'}
                            />
                        }
                        loading={restartingDaemon}
                        onPress={handleRestartDaemon}
                    />
                </ItemGroup>
            )}

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
                <Item
                    title={t('settings.mcpServers')}
                    subtitle={t('settings.mcpServersSubtitle')}
                    icon={<Ionicons name="extension-puzzle-outline" size={29} color="#8B5CF6" />}
                    onPress={() => router.push('/settings/mcp')}
                />
                {experiments && (
                    <Item
                        title={t('settings.usage')}
                        subtitle={t('settings.usageSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push('/settings/usage')}
                    />
                )}
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

            {/* Version */}
            <ItemGroup>
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
