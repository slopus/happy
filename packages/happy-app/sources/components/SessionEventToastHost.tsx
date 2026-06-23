import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
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
import { getSessionName } from '@/utils/sessionUtils';
import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';

const EVENT_STYLE: Record<SessionEventToast['kind'], {
    icon: keyof typeof Ionicons.glyphMap;
    color: string;
}> = {
    permission: { icon: 'key-outline', color: '#FF9500' },
    question: { icon: 'help-circle-outline', color: '#0EA5E9' },
    done: { icon: 'checkmark-circle-outline', color: '#34C759' },
};

const EMPTY_MESSAGES: Message[] = [];
const ACTIVE_ROUTE_TOAST_TTL_MS = 3_000;

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
    const pathname = usePathname();
    const styles = stylesheet;
    const eventStyle = EVENT_STYLE[toast.kind];
    const session = storage((state) => state.sessions[toast.sessionId] ?? null);
    const messages = storage((state) => state.sessionMessages[toast.sessionId]?.messages ?? EMPTY_MESSAGES);
    const copy = getToastCopy(toast, session, messages);
    const isActiveRoute = isToastTargetRouteActive(pathname, toast, session);

    React.useEffect(() => {
        const durationMs = isActiveRoute
            ? ACTIVE_ROUTE_TOAST_TTL_MS
            : Math.max(1000, toast.expiresAt - Date.now());
        const timeout = setTimeout(
            () => dismissSessionEventToast(toast.id),
            durationMs,
        );
        return () => clearTimeout(timeout);
    }, [isActiveRoute, toast.expiresAt, toast.id]);

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
                <Text numberOfLines={1} style={styles.title}>{copy.title}</Text>
                {!!copy.body && (
                    <Text numberOfLines={2} style={styles.body}>{copy.body}</Text>
                )}
            </View>
            <Pressable onPress={handleDismiss} hitSlop={8} style={styles.closeButton}>
                <Ionicons name="close" size={16} color="#8E8E93" />
            </Pressable>
        </Pressable>
    );
}

function getToastCopy(toast: SessionEventToast, session: Session | null, messages: Message[]): { title: string; body: string | null } {
    if (toast.kind !== 'done') {
        return {
            title: compactText(toast.title) || getSessionTitle(session),
            body: compactText(toast.body) || null,
        };
    }

    const sessionTitle = getSessionTitle(session);
    const body = getMeaningfulToastText(toast.body)
        || getMeaningfulToastText(toast.title)
        || getLatestAgentReplyPreview(messages);

    return {
        title: sessionTitle,
        body,
    };
}

function isToastTargetRouteActive(pathname: string, toast: SessionEventToast, session: Session | null): boolean {
    const [section, id] = splitRoute(pathname);
    if (section === 'session' && id === toast.sessionId) {
        return true;
    }

    const groupId = session?.metadata?.groupId;
    return !!groupId && section === 'group' && id === groupId;
}

function splitRoute(pathname: string): [string | null, string | null] {
    const [section, id] = pathname.split('/').filter(Boolean);
    return [safeDecodeURIComponent(section), safeDecodeURIComponent(id)];
}

function safeDecodeURIComponent(value: string | undefined): string | null {
    if (!value) {
        return null;
    }
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function getSessionTitle(session: Session | null): string {
    return getSessionName(session);
}

function getLatestAgentReplyPreview(messages: Message[]): string | null {
    const latestReply = [...messages]
        .sort((a, b) => b.createdAt - a.createdAt)
        .find((message) => message.kind === 'agent-text' && !message.isThinking && compactText(message.text));

    if (latestReply?.kind !== 'agent-text') {
        return null;
    }

    return truncateText(compactText(latestReply.text), 180);
}

function getMeaningfulToastText(text: string | null | undefined): string | null {
    const compact = compactText(text);
    if (!compact || isGenericCompletionText(compact)) {
        return null;
    }
    return truncateText(compact, 180);
}

function compactText(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength - 1)}…`;
}

function isGenericCompletionText(text: string): boolean {
    const normalized = text.toLowerCase().replace(/[.!。！\s]/g, '');
    return [
        'ready',
        'itsready',
        "it'sready",
        'done',
        'completed',
        'complete',
        'finished',
        '已完成',
        '完成',
    ].includes(normalized);
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
