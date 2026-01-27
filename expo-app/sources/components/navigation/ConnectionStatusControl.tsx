import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { StatusDot } from '@/components/StatusDot';
import { Popover } from '@/components/ui/popover';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { FloatingOverlay } from '@/components/FloatingOverlay';
import { useSocketStatus, useSyncError, useLastSyncAt } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { useAuth } from '@/auth/AuthContext';
import { useRouter } from 'expo-router';
import { sync } from '@/sync/sync';
import { Typography } from '@/constants/Typography';

type Variant = 'sidebar' | 'header';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
        zIndex: 2000,
        overflow: 'visible',
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
        flexWrap: 'nowrap' as const,
        maxWidth: '100%',
        overflow: 'visible',
    },
    statusText: {
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
        flexShrink: 1,
    },
    statusChevron: {
        marginLeft: 2,
        marginTop: 1,
        opacity: 0.9,
    },
    popoverTitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
        marginBottom: 8,
        paddingHorizontal: 16,
        paddingTop: 6,
        textTransform: 'uppercase',
    },
    popoverRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 6,
        paddingHorizontal: 16,
    },
    popoverLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    popoverValue: {
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default(),
        flexShrink: 1,
        textAlign: 'right',
    },
}));

function formatTime(ts: number | null): string {
    if (!ts) return '—';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return '—';
    }
}

export const ConnectionStatusControl = React.memo(function ConnectionStatusControl(props: {
    variant: Variant;
    textSize?: number;
    dotSize?: number;
    chevronSize?: number;
    alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'baseline';
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const auth = useAuth();
    const socketStatus = useSocketStatus();
    const syncError = useSyncError();
    const lastSyncAt = useLastSyncAt();

    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<any>(null);

    const connectionStatus = React.useMemo(() => {
        switch (socketStatus.status) {
            case 'connected':
                return { color: theme.colors.status.connected, isPulsing: false, text: t('status.connected') };
            case 'connecting':
                return { color: theme.colors.status.connecting, isPulsing: true, text: t('status.connecting') };
            case 'disconnected':
                return { color: theme.colors.status.disconnected, isPulsing: false, text: t('status.disconnected') };
            case 'error':
                return { color: theme.colors.status.error, isPulsing: false, text: t('status.error') };
            default:
                return { color: theme.colors.status.default, isPulsing: false, text: '' };
        }
    }, [socketStatus.status, theme.colors.status]);

    if (!connectionStatus.text) return null;

    const textSize = props.textSize ?? (props.variant === 'sidebar' ? 11 : 12);
    const dotSize = props.dotSize ?? 6;
    const chevronSize = props.chevronSize ?? 8;

    return (
        <>
            {/* Use a View wrapper for the anchor ref (stable, measurable). */}
            <View
                style={[styles.container, props.alignSelf ? { alignSelf: props.alignSelf } : null]}
                ref={anchorRef}
                collapsable={false}
            >
                <Pressable
                    style={styles.statusContainer}
                    onPress={() => setOpen(true)}
                    accessibilityRole="button"
                >
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={dotSize}
                        style={{ marginRight: 4 }}
                    />
                    <Text
                        style={[styles.statusText, { color: connectionStatus.color, fontSize: textSize }]}
                        numberOfLines={1}
                    >
                        {connectionStatus.text}
                    </Text>
                    <Ionicons
                        name={open ? "chevron-up" : "chevron-down"}
                        size={chevronSize}
                        color={connectionStatus.color}
                        style={styles.statusChevron}
                    />
                </Pressable>
                <Popover
                    open={open}
                    anchorRef={anchorRef}
                    placement="bottom"
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{
                        web: true,
                        native: true,
                        matchAnchorWidth: false,
                        anchorAlign: 'center',
                    }}
                    maxWidthCap={320}
                    maxHeightCap={520}
                    onRequestClose={() => setOpen(false)}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay
                            maxHeight={Math.max(220, Math.min(maxHeight, 520))}
                            keyboardShouldPersistTaps="always"
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                            edgeIndicators={true}
                        >
                            <View style={{ paddingTop: 8 }}>
                                <Text style={styles.popoverTitle}>Connection</Text>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>Server</Text>
                                    <Text style={styles.popoverValue} numberOfLines={2}>{getServerUrl()}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>Socket</Text>
                                    <Text style={styles.popoverValue}>{socketStatus.status}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>Authenticated</Text>
                                    <Text style={styles.popoverValue}>{auth.isAuthenticated ? 'Yes' : 'No'}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>Last sync</Text>
                                    <Text style={styles.popoverValue}>{formatTime(lastSyncAt)}</Text>
                                </View>

                                {syncError?.nextRetryAt ? (
                                    <View style={styles.popoverRow}>
                                        <Text style={styles.popoverLabel}>Next retry</Text>
                                        <Text style={styles.popoverValue}>{formatTime(syncError.nextRetryAt)}</Text>
                                    </View>
                                ) : null}

                                {syncError ? (
                                    <View style={styles.popoverRow}>
                                        <Text style={styles.popoverLabel}>Last error</Text>
                                        <Text style={styles.popoverValue} numberOfLines={3}>{syncError.message}</Text>
                                    </View>
                                ) : null}

                                <ActionListSection
                                    title="Actions"
                                    actions={[
                                        {
                                            id: 'retry',
                                            label: t('common.retry'),
                                            icon: <Ionicons name="refresh-outline" size={18} color={theme.colors.text} />,
                                            disabled: syncError?.retryable === false,
                                            onPress: () => {
                                                sync.retryNow();
                                                setOpen(false);
                                            }
                                        },
                                        syncError?.kind === 'auth' ? {
                                            id: 'restore',
                                            label: t('connect.restoreAccount'),
                                            icon: <Ionicons name="key-outline" size={18} color={theme.colors.text} />,
                                            onPress: () => {
                                                setOpen(false);
                                                router.push('/restore');
                                            }
                                        } : null,
                                        {
                                            id: 'server',
                                            label: t('server.serverConfiguration'),
                                            icon: <Ionicons name="server-outline" size={18} color={theme.colors.text} />,
                                            onPress: () => {
                                                setOpen(false);
                                                router.push('/server');
                                            }
                                        },
                                        {
                                            id: 'account',
                                            label: t('settings.account'),
                                            icon: <Ionicons name="person-outline" size={18} color={theme.colors.text} />,
                                            onPress: () => {
                                                setOpen(false);
                                                router.push('/settings/account');
                                            }
                                        },
                                    ]}
                                />
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            </View>

        </>
    );
});
