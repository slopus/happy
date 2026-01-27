import { View, ScrollView, Pressable, Platform, Linking, Text as RNText, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import Constants from 'expo-constants';
import { useAuth } from '@/auth/AuthContext';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useEntitlement, useLocalSettingMutable, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { isUsingCustomServer } from '@/sync/serverConfig';
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
import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { HappyError } from '@/utils/errors';
import { DEFAULT_AGENT_ID, getAgentCore, getAgentIconSource, getAgentIconTintColor, resolveAgentIdFromConnectedServiceId } from '@/agents/catalog';

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const isPro = __DEV__ || useEntitlement('pro');
    const experiments = useSetting('experiments');
    const expUsageReporting = useSetting('expUsageReporting');
    const useProfiles = useSetting('useProfiles');
    const terminalUseTmux = useSetting('sessionUseTmux');
    const isCustomServer = isUsingCustomServer();
    const allMachines = useAllMachines();
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);
    const [githubUnavailableReason, setGithubUnavailableReason] = React.useState<string | null>(null);

    const anthropicAgentId = resolveAgentIdFromConnectedServiceId('anthropic') ?? DEFAULT_AGENT_ID;
    const anthropicAgentCore = getAgentCore(anthropicAgentId);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const [refreshingMachines, refreshMachines] = useHappyAction(async () => {
        await sync.refreshMachinesThrottled({ force: true });
    });

    useFocusEffect(
        React.useCallback(() => {
            void sync.refreshMachinesThrottled({ staleMs: 30_000 });
        }, [])
    );

    const machinesTitle = React.useMemo(() => {
        const headerTextStyle = [
            Typography.default('regular'),
            {
                color: theme.colors.groupped.sectionTitle,
                fontSize: Platform.select({ ios: 13, default: 14 }),
                lineHeight: Platform.select({ ios: 18, default: 20 }),
                letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
                textTransform: 'uppercase' as const,
                fontWeight: Platform.select({ ios: 'normal', default: '500' }) as any,
            },
        ];

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <RNText style={headerTextStyle as any}>{t('settings.machines')}</RNText>
                <Pressable
                    onPress={refreshMachines}
                    hitSlop={10}
                    style={{ padding: 2 }}
                    accessibilityRole="button"
                    accessibilityLabel="Refresh"
                    disabled={refreshingMachines}
                >
                    {refreshingMachines
                        ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        : <Ionicons name="refresh" size={18} color={theme.colors.textSecondary} />}
                </Pressable>
            </View>
        );
    }, [refreshMachines, refreshingMachines, theme.colors.groupped.sectionTitle, theme.colors.textSecondary]);

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
        setGithubUnavailableReason(null);
        try {
            const params = await getGitHubOAuthParams(auth.credentials!);
            await Linking.openURL(params.url);
        } catch (e) {
            if (e instanceof HappyError && e.canTryAgain === false) {
                setGithubUnavailableReason(e.message);
            }
            throw e;
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

    // Anthropic connection
    const [connectingAnthropic, connectAnthropic] = useHappyAction(async () => {
        const route = anthropicAgentCore.connectedService.connectRoute;
        if (route) {
            router.push(route);
        }
    });

    // Anthropic disconnection
    const [disconnectingAnthropic, handleDisconnectAnthropic] = useHappyAction(async () => {
        const serviceName = anthropicAgentCore.connectedService.name;
        const confirmed = await Modal.confirm(
            t('modals.disconnectService', { service: serviceName }),
            t('modals.disconnectServiceConfirm', { service: serviceName }),
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
                    title={anthropicAgentCore.connectedService.name}
                    subtitle={isAnthropicConnected
                        ? t('settingsAccount.statusActive')
                        : t('settings.connectAccount')
                    }
                    icon={
                        <Image
                            source={getAgentIconSource(anthropicAgentId)}
                            style={{ width: 29, height: 29 }}
                            tintColor={getAgentIconTintColor(anthropicAgentId, theme)}
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
                        : (githubUnavailableReason ?? t('settings.connectGithubAccount'))
                    }
                    icon={
                        <Ionicons
                            name="logo-github"
                            size={29}
                            color={isGitHubConnected ? theme.colors.status.connected : theme.colors.textSecondary}
                        />
                    }
                    onPress={isGitHubConnected
                        ? handleDisconnectGitHub
                        : (githubUnavailableReason ? undefined : connectGitHub)
                    }
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
                <ItemGroup title={machinesTitle}>
                    {[...allMachines].map((machine) => {
                        const isOnline = isMachineOnline(machine);
                        const host = machine.metadata?.host || 'Unknown';
                        const displayName = machine.metadata?.displayName;
                        const platform = machine.metadata?.platform || '';

                        // Use displayName if available, otherwise use host
                        const title = displayName || host;

                        // Build subtitle: show hostname if different from title, plus platform and status
                        let subtitleTop = '';
                        if (displayName && displayName !== host) {
                            subtitleTop = host;
                        }
                        const statusText = isOnline ? t('status.online') : t('status.offline');
                        const statusLineText = platform ? `${platform} • ${statusText}` : statusText;

                        const subtitle = (
                            <View style={{ gap: 2 }}>
                                {subtitleTop ? (
                                    <RNText style={[Typography.default(), { fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 }]}>
                                        {subtitleTop}
                                    </RNText>
                                ) : null}
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    <RNText
                                        style={[
                                            Typography.default(),
                                            { fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20, flexShrink: 1 }
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {statusLineText}
                                    </RNText>
                                    <RNText style={[Typography.default(), { fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20, opacity: 0.8 }]}>
                                        {' • '}
                                    </RNText>
                                    <MachineCliGlyphs machineId={machine.id} isOnline={isOnline} />
                                </View>
                            </View>
                        );

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
                    onPress={() => router.push('/(app)/settings/account')}
                />
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/(app)/settings/appearance')}
                />
                <Item
                    title={t('settings.voiceAssistant')}
                    subtitle={t('settings.voiceAssistantSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                    onPress={() => router.push('/(app)/settings/voice')}
                />
                <Item
                    title={t('settings.featuresTitle')}
                    subtitle={t('settings.featuresSubtitle')}
                    icon={<Ionicons name="flask-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/(app)/settings/features')}
                />
                <Item
                    title={t('settings.session')}
                    subtitle={terminalUseTmux ? t('settings.sessionSubtitleTmuxEnabled') : t('settings.sessionSubtitleMessageSendingAndTmux')}
                    icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/(app)/settings/session')}
                />
                {useProfiles && (
                    <Item
                        title={t('settings.profiles')}
                        subtitle={t('settings.profilesSubtitle')}
                        icon={<Ionicons name="person-outline" size={29} color="#AF52DE" />}
                        onPress={() => router.push('/(app)/settings/profiles')}
                    />
                )}
                {useProfiles && (
                    <Item
                        title={t('settings.secrets')}
                        subtitle={t('settings.secretsSubtitle')}
                        icon={<Ionicons name="key-outline" size={29} color="#AF52DE" />}
                        onPress={() => router.push('/(app)/settings/secrets')}
                    />
                )}
                {experiments && expUsageReporting && (
                    <Item
                        title={t('settings.usage')}
                        subtitle={t('settings.usageSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push('/(app)/settings/usage')}
                    />
                )}
            </ItemGroup>

            {/* Developer */}
            {(__DEV__ || devModeEnabled) && (
                <ItemGroup title={t('settings.developer')}>
                    <Item
                        title={t('settings.developerTools')}
                        icon={<Ionicons name="construct-outline" size={29} color="#5856D6" />}
                        onPress={() => router.push('/(app)/dev')}
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
                        router.push('/(app)/changelog');
                    }}
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
