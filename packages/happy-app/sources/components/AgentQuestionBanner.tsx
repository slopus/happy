import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSessionPendingCommunications } from '@/sync/storage';
import type { PendingAgentCommunication } from '@/sync/agentCommunications';
import { sessionCancelCommunication } from '@/sync/ops';
import { AgentQuestionModal } from './AgentQuestionModal';

/**
 * Sits above the composer whenever the agent is waiting on the user. It stays
 * pinned rather than living in the transcript so a request cannot scroll out of
 * sight while the agent is blocked on it.
 *
 * A form opens the full-screen answer sheet. A communication of a kind this
 * build does not implement says so and offers to dismiss it, so the session is
 * never stuck on something this client cannot render.
 */
export function AgentQuestionBanner({ sessionId }: { sessionId: string }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const pendingCommunications = useSessionPendingCommunications(sessionId);
    const [openId, setOpenId] = React.useState<string | null>(null);

    const pending = pendingCommunications[0];
    const open = pending?.kind === 'form' && openId === pending.id;

    // Drop the modal as soon as its request is gone, so an answer from another
    // device closes the form here too.
    React.useEffect(() => {
        if (openId !== null && !pendingCommunications.some(item => item.id === openId)) {
            setOpenId(null);
        }
    }, [openId, pendingCommunications]);

    const handleDismissUnsupported = React.useCallback(async (id: string, rawKind: string) => {
        try {
            await sessionCancelCommunication(sessionId, id, rawKind);
        } catch {
            // The agent re-asks if the dismissal never lands; nothing to show here.
        }
    }, [sessionId]);

    if (!pending) return null;

    if (pending.kind === 'unsupported') {
        return (
            <AgentQuestionBannerView
                pending={pending}
                onDismiss={() => handleDismissUnsupported(pending.id, pending.rawKind)}
            />
        );
    }

    return (
        <>
            <AgentQuestionBannerView pending={pending} onPress={() => setOpenId(pending.id)} />
            <AgentQuestionModal
                pending={pending}
                sessionId={sessionId}
                visible={open}
                onClose={() => setOpenId(null)}
            />
        </>
    );
}

/**
 * The banner itself, with no store or network of its own, so it can be rendered
 * from the dev previews as well as from a live session.
 */
export function AgentQuestionBannerView({ pending, onPress, onDismiss }: {
    pending: PendingAgentCommunication;
    onPress?: () => void;
    onDismiss?: () => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (pending.kind === 'unsupported') {
        return (
            <View style={[styles.container, styles.containerUnsupported]}>
                <View style={styles.icon}>
                    <Ionicons name="alert-circle-outline" size={20} color={theme.colors.textSecondary} />
                </View>
                <View style={styles.body}>
                    <Text style={styles.title} numberOfLines={1}>
                        {pending.title ?? t('agentQuestion.unsupportedTitle')}
                    </Text>
                    <Text style={styles.subtitle} numberOfLines={2}>
                        {t('agentQuestion.unsupportedDescription', { kind: pending.rawKind })}
                    </Text>
                </View>
                <Pressable onPress={onDismiss} hitSlop={10}>
                    <Text style={styles.dismiss}>{t('agentQuestion.dismiss')}</Text>
                </Pressable>
            </View>
        );
    }

    const first = pending.questions[0];
    const remaining = pending.questions.length - 1;

    return (
        <Pressable style={styles.container} onPress={onPress}>
            <View style={styles.icon}>
                <Ionicons name="help-circle-outline" size={20} color={theme.colors.textLink} />
            </View>
            <View style={styles.body}>
                <Text style={styles.title} numberOfLines={1}>
                    {first?.header ?? t('agentQuestion.title')}
                </Text>
                <Text style={styles.subtitle} numberOfLines={2}>
                    {remaining > 0
                        ? t('agentQuestion.moreQuestions', { count: remaining })
                        : (first?.question ?? '')}
                </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
        </Pressable>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginHorizontal: 12,
        marginBottom: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.textLink,
    },
    containerUnsupported: {
        borderColor: theme.colors.divider,
    },
    icon: {
        width: 24,
        alignItems: 'center',
    },
    body: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    dismiss: {
        fontSize: 14,
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
}));
