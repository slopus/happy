import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from '@react-navigation/native';
import { Typography } from '@/constants/Typography';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { useSettingMutable, useProfile } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { useUnifiedAuthQrCode } from '@/hooks/useUnifiedAuthQrCode';
import { getDisplayName } from '@/sync/profile';
import { Image } from 'expo-image';
import { useHappyAction } from '@/hooks/useHappyAction';
import { disconnectGitHub } from '@/sync/apiGithub';
import { disconnectService } from '@/sync/apiServices';
import { fetchPushTokens, type PushToken } from '@/sync/apiPush';
import {
    getCurrentExpoPushToken,
    getCurrentPushDeviceMetadata,
    getPushPermissionInfo,
    requestPushPermissionOrOpenSettings,
    removePushToken,
    syncCurrentPushToken,
    type PushPermissionInfo,
} from '@/sync/pushRegistration';

function formatPushPermissionLabel(permission: PushPermissionInfo | null): string {
    if (!permission) {
        return t('pushNotifications.permissionLoading');
    }
    if (permission.status === 'unsupported') {
        return t('pushNotifications.permissionUnavailable');
    }
    if (permission.granted) {
        return t('pushNotifications.permissionAllowed');
    }
    if (permission.status === 'denied') {
        return t('pushNotifications.permissionDenied');
    }
    return t('pushNotifications.permissionNotRequested');
}

function formatPushPermissionSubtitle(permission: PushPermissionInfo | null): string {
    if (!permission) {
        return t('pushNotifications.subtitleChecking');
    }
    if (permission.status === 'unsupported') {
        return t('pushNotifications.subtitleUnsupported');
    }
    if (permission.granted) {
        return t('pushNotifications.subtitleGranted');
    }
    if (permission.canAskAgain) {
        return t('pushNotifications.subtitleCanAskAgain');
    }
    return t('pushNotifications.subtitleBlocked');
}

function formatPushTokenFingerprint(token: string): string {
    const rawValue = token.replace(/^ExponentPushToken\[/, '').replace(/\]$/, '');
    if (rawValue.length <= 12) {
        return rawValue;
    }
    return `${rawValue.slice(0, 6)}…${rawValue.slice(-6)}`;
}

function formatPushTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

function buildPushTokenSubtitle(pushToken: PushToken, options: {
    isCurrentDevice: boolean;
    currentDeviceLabel: string;
    currentAppLabel: string | null;
}): string {
    const lines: string[] = [];

    if (options.isCurrentDevice) {
        lines.push(options.currentDeviceLabel);
        if (options.currentAppLabel) {
            lines.push(options.currentAppLabel);
        }
    } else {
        lines.push(t('pushNotifications.otherDevice'));
    }

    lines.push(t('pushNotifications.registeredAt', { time: formatPushTimestamp(pushToken.createdAt) }));
    lines.push(t('pushNotifications.lastSeenAt', { time: formatPushTimestamp(pushToken.updatedAt) }));
    lines.push(t('pushNotifications.serverId', { id: pushToken.id }));
    lines.push(t('pushNotifications.tokenLine', { fingerprint: formatPushTokenFingerprint(pushToken.token) }));
    return lines.join('\n');
}

function buildPushRefreshFailureMessage(error?: string): string {
    return error ? `${t('pushNotifications.refreshFailed')}\n\n${error}` : t('pushNotifications.refreshFailed');
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [showSecret, setShowSecret] = useState(false);
    const [copiedRecently, setCopiedRecently] = useState(false);
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');
    const { connectAuthQrCode, isLoading: isConnecting } = useUnifiedAuthQrCode();
    const profile = useProfile();
    const currentPushDevice = useMemo(() => getCurrentPushDeviceMetadata(), []);
    const [pushTokens, setPushTokens] = useState<PushToken[]>([]);
    const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
    const [currentPushToken, setCurrentPushToken] = useState<string | null>(null);
    const [loadingPushSettings, setLoadingPushSettings] = useState(false);
    const [requestingPushPermission, setRequestingPushPermission] = useState(false);
    const [refreshingPushToken, setRefreshingPushToken] = useState(false);
    const [deletingPushToken, setDeletingPushToken] = useState<string | null>(null);
    const pushNotificationsUnsupported = Platform.OS === 'web' || pushPermission?.status === 'unsupported';

    // Get the current secret key
    const currentSecret = auth.credentials?.secret || '';
    const formattedSecret = currentSecret ? formatSecretKeyForBackup(currentSecret) : '';

    // Profile display values
    const displayName = getDisplayName(profile);
    const githubUsername = profile.github?.login;

    const loadPushSettings = useCallback(async (showError = false) => {
        if (!auth.credentials) {
            setPushTokens([]);
            setPushPermission(null);
            setCurrentPushToken(null);
            return;
        }

        setLoadingPushSettings(true);
        try {
            const [tokens, permission, liveToken] = await Promise.all([
                fetchPushTokens(auth.credentials),
                getPushPermissionInfo(),
                getCurrentExpoPushToken(),
            ]);
            setPushTokens(tokens);
            setPushPermission(permission);
            setCurrentPushToken(liveToken);
        } catch (error) {
            console.error('Failed to load push notification settings:', error);
            if (showError) {
                Modal.alert(t('common.error'), t('pushNotifications.loadFailed'));
            }
        } finally {
            setLoadingPushSettings(false);
        }
    }, [auth.credentials]);

    useEffect(() => {
        void loadPushSettings();
    }, [loadPushSettings]);

    useFocusEffect(
        useCallback(() => {
            void loadPushSettings();
        }, [loadPushSettings])
    );

    // GitHub disconnection
    const [disconnecting, handleDisconnectGitHub] = useHappyAction(async () => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectGithub'),
            t('modals.disconnectGithubConfirm'),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            await disconnectGitHub(auth.credentials!);
        }
    });

    // Service disconnection
    const [disconnectingService, setDisconnectingService] = useState<string | null>(null);
    const handleDisconnectService = async (service: string, displayName: string) => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectService', { service: displayName }),
            t('modals.disconnectServiceConfirm', { service: displayName }),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            setDisconnectingService(service);
            try {
                await disconnectService(auth.credentials!, service);
                await sync.refreshProfile();
                // The profile will be updated via sync
            } catch (error) {
                Modal.alert(t('common.error'), t('errors.disconnectServiceFailed', { service: displayName }));
            } finally {
                setDisconnectingService(null);
            }
        }
    };

    const handleShowSecret = () => {
        setShowSecret(!showSecret);
    };

    const handleCopySecret = async () => {
        try {
            await Clipboard.setStringAsync(formattedSecret);
            setCopiedRecently(true);
            setTimeout(() => setCopiedRecently(false), 2000);
            Modal.alert(t('common.success'), t('settingsAccount.secretKeyCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
        }
    };

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            t('common.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('common.logout'), destructive: true }
        );
        if (confirmed) {
            auth.logout();
        }
    };

    const handlePushPermissionRequest = useCallback(async () => {
        if (!auth.credentials) {
            return;
        }

        setRequestingPushPermission(true);
        try {
            const result = await requestPushPermissionOrOpenSettings();
            setPushPermission(result.permission);

            if (result.granted) {
                const syncResult = await syncCurrentPushToken(auth.credentials);
                await loadPushSettings();
                if (!syncResult.registered) {
                    Modal.alert(t('common.error'), buildPushRefreshFailureMessage(syncResult.error));
                    return;
                }
                Modal.alert(t('common.success'), t('pushNotifications.enabledForDevice'));
                return;
            }

            await loadPushSettings();

            if (result.openedSettings) {
                Modal.alert(t('pushNotifications.openSettingsTitle'), t('pushNotifications.openSettingsMessage'));
                return;
            }

            Modal.alert(t('common.error'), t('pushNotifications.permissionNotGranted'));
        } catch (error) {
            console.error('Failed to request push permission:', error);
            Modal.alert(t('common.error'), t('pushNotifications.requestFailed'));
        } finally {
            setRequestingPushPermission(false);
        }
    }, [auth.credentials, loadPushSettings]);

    const handleRefreshCurrentPushToken = useCallback(async () => {
        if (!auth.credentials) {
            return;
        }

        setRefreshingPushToken(true);
        try {
            const result = await syncCurrentPushToken(auth.credentials);
            setPushPermission(result.permission);
            await loadPushSettings();

            if (!result.permission.granted) {
                Modal.alert(t('common.error'), t('pushNotifications.notEnabledYet'));
                return;
            }

            if (!result.registered) {
                Modal.alert(t('common.error'), buildPushRefreshFailureMessage(result.error));
                return;
            }

            Modal.alert(t('common.success'), t('pushNotifications.tokenRefreshed'));
        } catch (error) {
            console.error('Failed to refresh push token:', error);
            Modal.alert(t('common.error'), t('pushNotifications.refreshFailed'));
        } finally {
            setRefreshingPushToken(false);
        }
    }, [auth.credentials, loadPushSettings]);

    const handleDeletePushToken = useCallback(async (pushToken: PushToken) => {
        if (!auth.credentials) {
            return;
        }

        const confirmed = await Modal.confirm(
            t('pushNotifications.deleteTitle'),
            t('pushNotifications.deleteMessage', { fingerprint: formatPushTokenFingerprint(pushToken.token) }),
            { confirmText: t('common.delete'), destructive: true }
        );

        if (!confirmed) {
            return;
        }

        setDeletingPushToken(pushToken.token);
        try {
            await removePushToken(auth.credentials, pushToken.token);
            await loadPushSettings();
        } catch (error) {
            console.error('Failed to delete push token:', error);
            Modal.alert(t('common.error'), t('pushNotifications.deleteFailed'));
        } finally {
            setDeletingPushToken(null);
        }
    }, [auth.credentials, loadPushSettings]);

    return (
        <>
            <ItemList>
                {/* Account Info */}
                <ItemGroup title={t('settingsAccount.accountInformation')}>
                    <Item
                        title={t('settingsAccount.status')}
                        detail={auth.isAuthenticated ? t('settingsAccount.statusActive') : t('settingsAccount.statusNotAuthenticated')}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsAccount.anonymousId')}
                        detail={sync.anonID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.anonID}
                    />
                    <Item
                        title={t('settingsAccount.publicId')}
                        detail={sync.serverID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.serverID}
                    />
                    {Platform.OS !== 'web' && (
                        <Item
                            title={t('settingsAccount.linkNewDevice')}
                            subtitle={isConnecting ? t('common.scanning') : t('settingsAccount.linkNewDeviceSubtitle')}
                            icon={<Ionicons name="qr-code-outline" size={29} color={theme.colors.accent} />}
                            onPress={connectAuthQrCode}
                            disabled={isConnecting}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>

                {/* Profile Section */}
                {(displayName || githubUsername || profile.avatar) && (
                    <ItemGroup title={t('settingsAccount.profile')}>
                        {displayName && (
                            <Item
                                title={t('settingsAccount.name')}
                                detail={displayName}
                                showChevron={false}
                            />
                        )}
                        {githubUsername && (
                            <Item
                                title={t('settingsAccount.github')}
                                detail={`@${githubUsername}`}
                                subtitle={t('settingsAccount.tapToDisconnect')}
                                onPress={handleDisconnectGitHub}
                                loading={disconnecting}
                                showChevron={false}
                                icon={profile.avatar?.url ? (
                                    <Image
                                        source={{ uri: profile.avatar.url }}
                                        style={{ width: 29, height: 29, borderRadius: 14.5 }}
                                        placeholder={{ thumbhash: profile.avatar.thumbhash }}
                                        contentFit="cover"
                                        transition={200}
                                        cachePolicy="memory-disk"
                                    />
                                ) : (
                                    <Ionicons name="logo-github" size={29} color={theme.colors.textSecondary} />
                                )}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Connected Services Section */}
                {profile.connectedServices && profile.connectedServices.length > 0 && (() => {
                    // Map of service IDs to display names and icons
                    const knownServices = {
                        anthropic: { name: 'Claude Code', icon: require('@/assets/images/icon-claude.png'), tintColor: null },
                        gemini: { name: 'Google Gemini', icon: require('@/assets/images/icon-gemini.png'), tintColor: null },
                        openai: { name: 'OpenAI Codex', icon: require('@/assets/images/icon-gpt.png'), tintColor: theme.colors.text }
                    };
                    
                    // Filter to only known services
                    const displayServices = profile.connectedServices.filter(
                        service => service in knownServices
                    );
                    
                    if (displayServices.length === 0) return null;
                    
                    return (
                        <ItemGroup title={t('settings.connectedAccounts')}>
                            {displayServices.map(service => {
                                const serviceInfo = knownServices[service as keyof typeof knownServices];
                                const isDisconnecting = disconnectingService === service;
                                return (
                                    <Item
                                        key={service}
                                        title={serviceInfo.name}
                                        detail={t('settingsAccount.statusActive')}
                                        subtitle={t('settingsAccount.tapToDisconnect')}
                                        onPress={() => handleDisconnectService(service, serviceInfo.name)}
                                        loading={isDisconnecting}
                                        disabled={isDisconnecting}
                                        showChevron={false}
                                        icon={
                                            <Image
                                                source={serviceInfo.icon}
                                                style={{ width: 29, height: 29 }}
                                                tintColor={serviceInfo.tintColor}
                                                contentFit="contain"
                                            />
                                        }
                                    />
                                );
                            })}
                        </ItemGroup>
                    );
                })()}

                {/* Backup Section */}
                <ItemGroup
                    title={t('settingsAccount.backup')}
                    footer={t('settingsAccount.backupDescription')}
                >
                    <Item
                        title={t('settingsAccount.secretKey')}
                        subtitle={showSecret ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                        icon={<Ionicons name={showSecret ? "eye-off-outline" : "eye-outline"} size={29} color="#FF9500" />}
                        onPress={handleShowSecret}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Secret Key Display */}
                {showSecret && (
                    <ItemGroup>
                        <Pressable onPress={handleCopySecret}>
                            <View style={{
                                backgroundColor: theme.colors.surface,
                                paddingHorizontal: 16,
                                paddingVertical: 14,
                                width: '100%',
                                maxWidth: layout.maxWidth,
                                alignSelf: 'center'
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: theme.colors.textSecondary,
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        ...Typography.default('semiBold')
                                    }}>
                                        {t('settingsAccount.secretKeyLabel')}
                                    </Text>
                                    <Ionicons
                                        name={copiedRecently ? "checkmark-circle" : "copy-outline"}
                                        size={18}
                                        color={copiedRecently ? "#34C759" : theme.colors.textSecondary}
                                    />
                                </View>
                                <Text style={{
                                    fontSize: 13,
                                    letterSpacing: 0.5,
                                    lineHeight: 20,
                                    color: theme.colors.text,
                                    ...Typography.mono()
                                }}>
                                    {formattedSecret}
                                </Text>
                            </View>
                        </Pressable>
                    </ItemGroup>
                )}

                {/* Analytics Section */}
                <ItemGroup
                    title={t('settingsAccount.privacy')}
                    footer={t('settingsAccount.privacyDescription')}
                >
                    <Item
                        title={t('settingsAccount.analytics')}
                        subtitle={analyticsOptOut ? t('settingsAccount.analyticsDisabled') : t('settingsAccount.analyticsEnabled')}
                        rightElement={
                            <Switch
                                accessibilityLabel={t('settingsAccount.analytics')}
                                value={!analyticsOptOut}
                                onValueChange={(value) => {
                                    const optOut = !value;
                                    setAnalyticsOptOut(optOut);
                                }}
                                trackColor={{ false: '#767577', true: '#34C759' }}
                                thumbColor="#FFFFFF"
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup
                    title={t('pushNotifications.title')}
                    footer={t('pushNotifications.footer')}
                >
                    <Item
                        title={t('pushNotifications.permission')}
                        detail={pushNotificationsUnsupported
                            ? t('pushNotifications.permissionUnavailable')
                            : formatPushPermissionLabel(pushPermission)}
                        subtitle={pushNotificationsUnsupported
                            ? t('pushNotifications.subtitleUnsupported')
                            : formatPushPermissionSubtitle(pushPermission)}
                        icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.accent} />}
                        loading={loadingPushSettings}
                        showChevron={false}
                    />
                    <Item
                        title={t('pushNotifications.requestAgain')}
                        subtitle={pushNotificationsUnsupported
                            ? t('pushNotifications.requestAgainUnsupported')
                            : pushPermission?.canAskAgain
                            ? t('pushNotifications.requestAgainCanAsk')
                            : t('pushNotifications.requestAgainBlocked')}
                        icon={<Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />}
                        onPress={handlePushPermissionRequest}
                        loading={requestingPushPermission}
                        disabled={requestingPushPermission || loadingPushSettings || pushNotificationsUnsupported || !auth.credentials}
                        showChevron={false}
                    />
                    <Item
                        title={t('pushNotifications.reRegister')}
                        subtitle={pushNotificationsUnsupported
                            ? t('pushNotifications.requestAgainUnsupported')
                            : currentPushToken
                                ? t('pushNotifications.currentToken', { fingerprint: formatPushTokenFingerprint(currentPushToken) })
                                : t('pushNotifications.reRegisterSubtitle')}
                        icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                        onPress={handleRefreshCurrentPushToken}
                        loading={refreshingPushToken}
                        disabled={refreshingPushToken || loadingPushSettings || pushNotificationsUnsupported || !auth.credentials}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup
                    title={t('pushNotifications.registeredTokensTitle', { count: pushTokens.length })}
                    footer={t('pushNotifications.registeredTokensFooter')}
                >
                    {pushTokens.length === 0 ? (
                        <Item
                            title={t('pushNotifications.noTokensTitle')}
                            subtitle={t('pushNotifications.noTokensSubtitle')}
                            showChevron={false}
                        />
                    ) : (
                        <>
                            {pushTokens.map((pushToken) => {
                                const isCurrentDevice = currentPushToken === pushToken.token;
                                return (
                                    <Item
                                        key={pushToken.id}
                                        title={formatPushTokenFingerprint(pushToken.token)}
                                        detail={isCurrentDevice ? t('pushNotifications.thisDevice') : undefined}
                                        subtitle={buildPushTokenSubtitle(pushToken, {
                                            isCurrentDevice,
                                            currentDeviceLabel: currentPushDevice.deviceLabel,
                                            currentAppLabel: currentPushDevice.appLabel,
                                        })}
                                        subtitleLines={0}
                                        icon={(
                                            <Ionicons
                                                name={isCurrentDevice ? 'phone-portrait-outline' : 'trash-outline'}
                                                size={29}
                                                color={isCurrentDevice ? theme.colors.textSecondary : '#FF3B30'}
                                            />
                                        )}
                                        onPress={isCurrentDevice ? undefined : () => handleDeletePushToken(pushToken)}
                                        loading={deletingPushToken === pushToken.token}
                                        disabled={deletingPushToken !== null}
                                        showChevron={false}
                                        copy={isCurrentDevice ? pushToken.token : false}
                                    />
                                );
                            })}
                        </>
                    )}
                </ItemGroup>

                {/* Danger Zone */}
                <ItemGroup title={t('settingsAccount.dangerZone')}>
                    <Item
                        title={t('settingsAccount.logout')}
                        subtitle={t('settingsAccount.logoutSubtitle')}
                        icon={<Ionicons name="log-out-outline" size={29} color="#FF3B30" />}
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
});
