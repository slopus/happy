import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import {
    dismissSessionEventToast,
    useSessionEventToasts,
} from '@/sync/sessionEventToasts';
import type { SessionEventToast } from '@/sync/sessionEventToasts';
import { storage } from '@/sync/storage';
import { navigateToSession } from '@/hooks/useNavigateToSession';

const EVENT_STYLE: Record<SessionEventToast['kind'], {
    icon: keyof typeof Ionicons.glyphMap;
    color: string;
}> = {
    permission: { icon: 'key-outline', color: '#FF9500' },
    question: { icon: 'help-circle-outline', color: '#0EA5E9' },
    done: { icon: 'checkmark-circle-outline', color: '#34C759' },
};

export function SessionEventToastHost() {
    const toasts = useSessionEventToasts();
    const styles = stylesheet;

    if (toasts.length === 0) {
        return null;
    }

    return (
        <View pointerEvents="box-none" style={styles.host}>
            {toasts.map((toast) => (
                <SessionEventToastItem key={toast.id} toast={toast} />
            ))}
        </View>
    );
}

function SessionEventToastItem({ toast }: { toast: SessionEventToast }) {
    const router = useRouter();
    const styles = stylesheet;
    const eventStyle = EVENT_STYLE[toast.kind];

    React.useEffect(() => {
        const timeout = setTimeout(
            () => dismissSessionEventToast(toast.id),
            Math.max(1000, toast.expiresAt - Date.now()),
        );
        return () => clearTimeout(timeout);
    }, [toast.expiresAt, toast.id]);

    const handlePress = React.useCallback(() => {
        dismissSessionEventToast(toast.id);

        const session = storage.getState().sessions[toast.sessionId];
        const groupId = session?.metadata?.groupId;
        if (groupId) {
            router.push(`/group/${encodeURIComponent(groupId)}`);
            return;
        }

        navigateToSession(router, toast.sessionId);
    }, [router, toast.id, toast.sessionId]);

    const handleDismiss = React.useCallback((event: any) => {
        event.stopPropagation?.();
        dismissSessionEventToast(toast.id);
    }, [toast.id]);

    return (
        <Pressable
            onPress={handlePress}
            style={({ pressed }) => [
                styles.toast,
                pressed && styles.toastPressed,
            ]}
        >
            <View style={[styles.iconWrap, { backgroundColor: `${eventStyle.color}1A` }]}>
                <Ionicons name={eventStyle.icon} size={18} color={eventStyle.color} />
            </View>
            <View style={styles.textWrap}>
                <Text numberOfLines={1} style={styles.title}>{toast.title}</Text>
                {!!toast.body && (
                    <Text numberOfLines={2} style={styles.body}>{toast.body}</Text>
                )}
            </View>
            <Pressable onPress={handleDismiss} hitSlop={8} style={styles.closeButton}>
                <Ionicons name="close" size={16} color="#8E8E93" />
            </Pressable>
        </Pressable>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    host: {
        position: 'absolute',
        top: Platform.OS === 'web' ? 58 : 72,
        right: 16,
        width: Platform.OS === 'web' ? 360 : '92%',
        maxWidth: Platform.OS === 'web' ? 'calc(100vw - 32px)' as any : 360,
        gap: 10,
        zIndex: 1000,
    },
    toast: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: '#000000',
        shadowOpacity: theme.dark ? 0.35 : 0.14,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
    },
    toastPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    iconWrap: {
        width: 30,
        height: 30,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    textWrap: {
        flex: 1,
        minWidth: 0,
        paddingTop: 1,
    },
    title: {
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    body: {
        marginTop: 3,
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 17,
        ...Typography.default(),
    },
    closeButton: {
        width: 24,
        height: 24,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
