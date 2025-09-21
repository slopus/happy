import { View, ScrollView, Pressable, Platform, Linking, TextInput, Alert } from 'react-native';
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
import { trackPaywallButtonClicked } from '@/track';
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

// Manual Auth Modal Component for Android
function ManualAuthModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string) => void }) {
    const { theme } = useUnistyles();
    const [url, setUrl] = React.useState('');

    return (
        <View style={{ padding: 20, backgroundColor: theme.colors.surface, borderRadius: 12, minWidth: 300 }}>
            <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
                {t('modals.authenticateTerminal')}
            </Text>
            <Text style={{ fontSize: 14, color: theme.colors.textSecondary, marginBottom: 16 }}>
                {t('modals.pasteUrlFromTerminal')}
            </Text>
            <TextInput
                style={{
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 14,
                    marginBottom: 20,
                    color: theme.colors.input.text,
                    backgroundColor: theme.colors.input.background
                }}
                value={url}
                onChangeText={setUrl}
                placeholder={'happy://terminal?...'}
                placeholderTextColor={theme.colors.input.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Pressable
                    onPress={onClose}
                    style={{ paddingVertical: 8, paddingHorizontal: 16, marginRight: 8 }}
                >
                    <Text style={{ color: '#007AFF', fontSize: 16 }}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    onPress={() => {
                        if (url.trim()) {
                            onSubmit(url.trim());
                            onClose();
                        }
                    }}
                    style={{ paddingVertical: 8, paddingHorizontal: 16 }}
                >
                    <Text style={{ color: '#007AFF', fontSize: 16, fontWeight: '600' }}>
                        {t('common.authenticate')}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

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
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                        onPress={() => {
                            if (Platform.OS === 'ios') {
                                Alert.prompt(
                                    t('modals.authenticateTerminal'),
                                    t('modals.pasteUrlFromTerminal'),
                                    [
                                        { text: 'Cancel', style: 'cancel' },
                                        {
                                            text: 'Authenticate',
                                            onPress: (url?: string) => {
                                                if (url?.trim()) {
                                                    connectWithUrl(url.trim());
                                                }
                                            }
                                        }
                                    ],
                                    'plain-text',
                                    '',
                                    'happy://terminal?...'
                                );
                            } else {
                                // For Android, show a custom modal
                                Modal.show({
                                    component: ManualAuthModal,
                                    props: {
                                        onSubmit: (url: string) => {
                                            connectWithUrl(url);
                                        }
                                    }
                                });
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Support Us */}
            <ItemGroup>
                <Item
                    title={t('settings.supportUs')}
                    subtitle={isPro ? t('settings.supportUsSubtitlePro') : t('settings.supportUsSubtitle')}
                    icon={<Ionicons name="heart" size={29} color="#FF3B30" />}
                    showChevron={false}
                    onPress={isPro ? undefined : handleSubscribe}
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

            {/* About */}
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                <Item
                    title={t('settings.whatsNew')}
                    subtitle={t('settings.whatsNewSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/changelog')}
                />
                <Item
                    title={t('settings.github')}
                    icon={<Ionicons name="logo-github" size={29} color={theme.colors.text} />}
                    detail="slopus/happy"
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
                        const url = 'https://happy.engineering/privacy/';
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
                        const url = 'https://github.com/slopus/happy/blob/main/TERMS.md';
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
