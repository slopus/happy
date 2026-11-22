import * as React from 'react';
import { WebStorageDiagnosticsItem } from '@/persistence/WebStorageDiagnosticsItem';
import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { useLocalSettingMutable, useSocketStatus } from '@/sync/storage';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { getServerUrl, setServerUrl, validateServerUrl, getLogServerUrl, setLogServerUrl } from '@/sync/serverConfig';
import { Switch } from '@/components/Switch';
import { useUnistyles } from 'react-native-unistyles';
import { setLastViewedTitle } from '@/changelog';
import { t } from '@/text';

export default function DevScreen() {
    const router = useRouter();
    const [debugMode, setDebugMode] = useLocalSettingMutable('debugMode');
    const [verboseLogging, setVerboseLogging] = useLocalSettingMutable('verboseLogging');
    const [consoleLoggingEnabled, setConsoleLoggingEnabled] = useLocalSettingMutable('consoleLoggingEnabled');
    const socketStatus = useSocketStatus();
    const anonymousId = sync.encryption!.anonID;
    const { theme } = useUnistyles();

    const handleEditServerUrl = async () => {
        const currentUrl = getServerUrl();

        const newUrl = await Modal.prompt(
            t('devTools.editApiEndpoint'),
            t('devTools.enterServerUrl'),
            {
                defaultValue: currentUrl,
                confirmText: t('common.save')
            }
        );

        if (newUrl && newUrl !== currentUrl) {
            const validation = validateServerUrl(newUrl);
            if (validation.valid) {
                setServerUrl(newUrl);
                Modal.alert(t('common.success'), t('devTools.serverUrlUpdated'));
            } else {
                Modal.alert(t('devTools.invalidUrl'), validation.error || t('devTools.enterValidUrl'));
            }
        }
    };

    const handleEditLogServerUrl = async () => {
        const currentUrl = getLogServerUrl() || '';

        const newUrl = await Modal.prompt(
            t('devTools.remoteLogServer'),
            t('devTools.remoteLogServerMessage'),
            {
                defaultValue: currentUrl,
                confirmText: t('common.save')
            }
        );

        if (newUrl !== undefined && newUrl !== currentUrl) {
            if (!newUrl || !newUrl.trim()) {
                setLogServerUrl(null);
                Modal.alert(t('common.success'), t('devTools.remoteLoggingDisabled'));
            } else {
                const validation = validateServerUrl(newUrl);
                if (validation.valid) {
                    setLogServerUrl(newUrl);
                    Modal.alert(t('common.success'), t('devTools.logServerUpdated'));
                } else {
                    Modal.alert(t('devTools.invalidUrl'), validation.error || t('devTools.enterValidUrl'));
                }
            }
        }
    };

    const handleClearCache = async () => {
        const confirmed = await Modal.confirm(
            t('devTools.clearCache'),
            t('devTools.clearCacheConfirmMessage'),
            { confirmText: t('devTools.clearAction'), destructive: true }
        );
        if (confirmed) {
            console.log('Cache cleared');
            Modal.alert(t('common.success'), t('devTools.cacheCleared'));
        }
    };

    // Helper function to format time ago
    const formatTimeAgo = (timestamp: number | null): string => {
        if (!timestamp) return '';

        const now = Date.now();
        const diff = now - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 10) return t('time.justNow');
        if (seconds < 60) return t('devTools.secondsAgo', { count: seconds });
        if (minutes < 60) return t('time.minutesAgo', { count: minutes });
        if (hours < 24) return t('time.hoursAgo', { count: hours });
        if (days < 7) return t('time.daysAgo', { count: days });

        return new Date(timestamp).toLocaleDateString();
    };

    // Helper function to get socket status subtitle
    const getSocketStatusSubtitle = (): string => {
        const { status, lastConnectedAt, lastDisconnectedAt } = socketStatus;

        if (status === 'connected' && lastConnectedAt) {
            return t('devTools.socketConnected', { time: formatTimeAgo(lastConnectedAt) });
        } else if ((status === 'disconnected' || status === 'error') && lastDisconnectedAt) {
            return t('devTools.socketLastConnected', { time: formatTimeAgo(lastDisconnectedAt) });
        } else if (status === 'connecting') {
            return t('devTools.socketConnecting');
        }

        return t('devTools.noConnectionInfo');
    };

    const getSocketStatusLabel = (): string => {
        switch (socketStatus.status) {
            case 'connected':
                return t('status.connected');
            case 'connecting':
                return t('status.connecting');
            case 'error':
                return t('status.error');
            case 'disconnected':
                return t('status.disconnected');
            default:
                return t('status.unknown');
        }
    };

    // Socket status indicator component
    const SocketStatusIndicator = () => {
        switch (socketStatus.status) {
            case 'connected':
                return <Ionicons name="checkmark-circle" size={22} color="#34C759" />;
            case 'connecting':
                return <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
            case 'error':
                return <Ionicons name="close-circle" size={22} color="#FF3B30" />;
            case 'disconnected':
                return <Ionicons name="close-circle" size={22} color="#FF9500" />;
            default:
                return <Ionicons name="help-circle" size={22} color="#8E8E93" />;
        }
    };

    return (
        <ItemList>
            <WebStorageDiagnosticsItem />
            <ItemGroup title={t('devTools.appInformation')}>
                <Item
                    title={t('common.version')}
                    detail={Constants.expoConfig?.version || '1.0.0'}
                />
                <Item
                    title={t('devTools.buildNumber')}
                    detail={Application.nativeBuildVersion || 'N/A'}
                />
                <Item
                    title={t('devTools.sdkVersion')}
                    detail={Constants.expoConfig?.sdkVersion || t('common.unknown')}
                />
                <Item
                    title={t('machine.platform')}
                    detail={`${Constants.platform?.ios ? 'iOS' : 'Android'} ${Constants.systemVersion || ''}`}
                />
                <Item
                    title={t('settingsAccount.anonymousId')}
                    detail={anonymousId}
                />
            </ItemGroup>

            <ItemGroup title={t('devTools.debugOptions')}>
                <Item
                    title={t('devTools.debugMode')}
                    rightElement={
                        <Switch
                            value={debugMode}
                            onValueChange={setDebugMode}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('devTools.consoleOutput')}
                    subtitle={t('devTools.consoleOutputSubtitle')}
                    rightElement={
                        <Switch
                            value={consoleLoggingEnabled}
                            onValueChange={setConsoleLoggingEnabled}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('devTools.verboseLogging')}
                    subtitle={t('devTools.verboseLoggingSubtitle')}
                    rightElement={
                        <Switch
                            value={verboseLogging}
                            onValueChange={setVerboseLogging}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('devTools.viewLogs')}
                    icon={<Ionicons name="document-text-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/logs')}
                />
            </ItemGroup>

            <ItemGroup title={t('devTools.ota')} footer={t('devTools.otaFooter')}>
                <Item
                    title={t('devTools.otaVersions')}
                    subtitle={t('devTools.otaVersionsSubtitle')}
                    icon={<Ionicons name="cube-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/ota-versions' as any)}
                />
            </ItemGroup>

            <ItemGroup title={t('devTools.componentDemos')}>
                <Item
                    title={t('devTools.deviceInfo')}
                    subtitle={t('devTools.deviceInfoSubtitle')}
                    icon={<Ionicons name="phone-portrait-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/device-info')}
                />
                <Item
                    title={t('devTools.listComponents')}
                    subtitle={t('devTools.listComponentsSubtitle')}
                    icon={<Ionicons name="list-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/list-demo')}
                />
                <Item
                    title={t('devTools.typography')}
                    subtitle={t('devTools.typographySubtitle')}
                    icon={<Ionicons name="text-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/typography')}
                />
                <Item
                    title={t('devTools.colors')}
                    subtitle={t('devTools.colorsSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/colors')}
                />
                <Item
                    title={t('devTools.messageDemos')}
                    subtitle={t('devTools.messageDemosSubtitle')}
                    icon={<Ionicons name="chatbubbles-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/messages-demo')}
                />
                <Item
                    title={t('devTools.invertedListTest')}
                    subtitle={t('devTools.invertedListTestSubtitle')}
                    icon={<Ionicons name="swap-vertical-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/inverted-list')}
                />
                <Item
                    title={t('devTools.toolViews')}
                    subtitle={t('devTools.toolViewsSubtitle')}
                    icon={<Ionicons name="construct-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/tools2')}
                />
                <Item
                    title={t('devTools.shimmerView')}
                    subtitle={t('devTools.shimmerViewSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/shimmer-demo')}
                />
                <Item
                    title={t('devTools.multiTextInput')}
                    subtitle={t('devTools.multiTextInputSubtitle')}
                    icon={<Ionicons name="create-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/multi-text-input')}
                />
                <Item
                    title={t('devTools.inputStyles')}
                    subtitle={t('devTools.inputStylesSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/input-styles')}
                />
                <Item
                    title={t('devTools.modalSystem')}
                    subtitle={t('devTools.modalSystemSubtitle')}
                    icon={<Ionicons name="albums-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/modal-demo')}
                />
                <Item
                    title={t('devTools.unitTests')}
                    subtitle={t('devTools.unitTestsSubtitle')}
                    icon={<Ionicons name="flask-outline" size={28} color="#34C759" />}
                    onPress={() => router.push('/dev/tests')}
                />
                <Item
                    title={t('devTools.unistylesDemo')}
                    subtitle={t('devTools.unistylesDemoSubtitle')}
                    icon={<Ionicons name="brush-outline" size={28} color="#FF6B6B" />}
                    onPress={() => router.push('/dev/unistyles-demo')}
                />
                <Item
                    title={t('devTools.qrCodeTest')}
                    subtitle={t('devTools.qrCodeTestSubtitle')}
                    icon={<Ionicons name="qr-code-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/qr-test')}
                />
                <Item
                    title={t('devTools.sessionComposer')}
                    subtitle={t('devTools.sessionComposerSubtitle')}
                    icon={<Ionicons name="add-circle-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/session-composer' as any)}
                />
            </ItemGroup>

            <ItemGroup title={t('devTools.testFeatures')} footer={t('devTools.testFeaturesFooter')}>
                <Item
                    title={t('devTools.claudeOauthTest')}
                    subtitle={t('devTools.claudeOauthTestSubtitle')}
                    icon={<Ionicons name="key-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/settings/connect/claude')}
                />
                <Item
                    title={t('devTools.testCrash')}
                    subtitle={t('devTools.testCrashSubtitle')}
                    destructive={true}
                    icon={<Ionicons name="warning-outline" size={28} color="#FF3B30" />}
                    onPress={async () => {
                        const confirmed = await Modal.confirm(
                            t('devTools.testCrash'),
                            t('devTools.testCrashConfirmMessage'),
                            { confirmText: t('devTools.crashAction'), destructive: true }
                        );
                        if (confirmed) {
                            throw new Error(t('devTools.testCrashError'));
                        }
                    }}
                />
                <Item
                    title={t('devTools.clearCache')}
                    subtitle={t('devTools.clearCacheSubtitle')}
                    icon={<Ionicons name="trash-outline" size={28} color="#FF9500" />}
                    onPress={handleClearCache}
                />
                <Item
                    title={t('devTools.resetChangelog')}
                    subtitle={t('devTools.resetChangelogSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => {
                        setLastViewedTitle('');
                        Modal.alert(t('common.success'), t('devTools.changelogReset'));
                    }}
                />
                <Item
                    title={t('devTools.resetAppState')}
                    subtitle={t('devTools.resetAppStateSubtitle')}
                    destructive={true}
                    icon={<Ionicons name="refresh-outline" size={28} color="#FF3B30" />}
                    onPress={async () => {
                        const confirmed = await Modal.confirm(
                            t('devTools.resetAppState'),
                            t('devTools.resetAppConfirmMessage'),
                            { confirmText: t('common.reset'), destructive: true }
                        );
                        if (confirmed) {
                            await sync.resetLocalHistory();
                            console.log('App state reset');
                        }
                    }}
                />
            </ItemGroup>

            <ItemGroup title={t('devTools.system')}>
                <Item
                    title={t('devTools.purchases')}
                    subtitle={t('devTools.purchasesSubtitle')}
                    icon={<Ionicons name="card-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/purchases')}
                />
                <Item
                    title={t('devTools.expoConstants')}
                    subtitle={t('devTools.expoConstantsSubtitle')}
                    icon={<Ionicons name="information-circle-outline" size={28} color={theme.colors.accent} />}
                    onPress={() => router.push('/dev/expo-constants')}
                />
            </ItemGroup>

            <ItemGroup title={t('devTools.network')}>
                <Item
                    title={t('devTools.apiEndpoint')}
                    detail={getServerUrl()}
                    onPress={handleEditServerUrl}
                    detailStyle={{ flex: 1, textAlign: 'right', minWidth: '70%' }}
                />
                <Item
                    title={t('devTools.logServer')}
                    subtitle={t('devTools.logServerSubtitle')}
                    detail={getLogServerUrl() || t('devTools.off')}
                    onPress={handleEditLogServerUrl}
                    detailStyle={{ flex: 1, textAlign: 'right', minWidth: '50%' }}
                />
                <Item
                    title={t('devTools.socketStatus')}
                    subtitle={getSocketStatusSubtitle()}
                    detail={getSocketStatusLabel()}
                    rightElement={<SocketStatusIndicator />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
}
