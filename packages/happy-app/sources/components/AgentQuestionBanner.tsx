import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSessionPendingCommunications } from '@/sync/storage';
import { type PendingAgentCommunication } from '@/sync/agentCommunications';
import { sessionAnswerQuestion, sessionCancelCommunication } from '@/sync/ops';
import {
    InlineQuestionForm,
    toCommunicationAnswers,
    type InlineQuestionAnswers,
} from '@/components/tools/views/InlineQuestionForm';

/**
 * Last-resort surface above the composer for requests the transcript is not
 * showing. A pending form whose tool message never arrived (older CLI, trimmed
 * history) renders as the same inline form used in the transcript, so every
 * question stays answerable in place. A form with no questions, or a
 * communication kind this build does not implement, gets a dismissible notice
 * so the session is never silently stuck.
 */
export function AgentQuestionBanner({ sessionId, transcriptQuestionToolIds }: {
    sessionId: string;
    transcriptQuestionToolIds?: ReadonlySet<string>;
}) {
    const pendingCommunications = useSessionPendingCommunications(sessionId);

    const handleDismiss = React.useCallback(async (id: string, rawKind: string) => {
        try {
            await sessionCancelCommunication(sessionId, id, rawKind);
        } catch {
            // The agent re-asks if the dismissal never lands; nothing to show here.
        }
    }, [sessionId]);

    // The transcript owns any form whose tool call it renders.
    const unclaimed = pendingCommunications.filter(communication => {
        const joinId = communication.toolUseId ?? communication.id;
        return !transcriptQuestionToolIds?.has(joinId);
    });

    if (unclaimed.length === 0) return null;

    return (
        <>
            {unclaimed.map(pending => {
                if (pending.kind === 'form' && pending.questions.length > 0) {
                    return (
                        <View key={pending.id} style={stylesheet.inlineFormContainer}>
                            <InlineQuestionForm
                                questions={pending.questions}
                                canInteract
                                onSubmit={async (answers: InlineQuestionAnswers) => {
                                    await sessionAnswerQuestion(
                                        sessionId,
                                        pending.id,
                                        toCommunicationAnswers(answers),
                                        'form',
                                    );
                                }}
                            />
                        </View>
                    );
                }
                const rawKind = pending.kind === 'unsupported' ? pending.rawKind : 'form';
                return (
                    <AgentQuestionBannerView
                        key={pending.id}
                        pending={pending}
                        onDismiss={() => handleDismiss(pending.id, rawKind)}
                    />
                );
            })}
        </>
    );
}

/**
 * The dismissible notice, with no store or network of its own, so it can be
 * rendered from the dev previews as well as from a live session.
 */
export function AgentQuestionBannerView({ pending, onDismiss }: {
    pending: PendingAgentCommunication;
    onDismiss?: () => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const kindLabel = pending.kind === 'unsupported' ? pending.rawKind : 'form';
    const title = (pending.kind === 'unsupported' ? pending.title : null)
        ?? t('agentQuestion.unsupportedTitle');

    return (
        <View style={[styles.container, styles.containerUnsupported]}>
            <View style={styles.icon}>
                <Ionicons name="alert-circle-outline" size={20} color={theme.colors.textSecondary} />
            </View>
            <View style={styles.body}>
                <Text style={styles.title} numberOfLines={1}>{title}</Text>
                <Text style={styles.subtitle} numberOfLines={2}>
                    {t('agentQuestion.unsupportedDescription', { kind: kindLabel })}
                </Text>
            </View>
            <Pressable onPress={onDismiss} hitSlop={10}>
                <Text style={styles.dismiss}>{t('agentQuestion.dismiss')}</Text>
            </Pressable>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    inlineFormContainer: {
        marginHorizontal: 12,
        marginBottom: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.textLink,
    },
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
