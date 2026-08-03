import * as React from 'react';
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    buildAnswers,
    canSubmit,
    isQuestionAnswered,
    toggleOption,
    type AgentQuestionDraft,
    type PendingAgentForm,
} from '@/sync/agentCommunications';
import { sessionAnswerQuestion, sessionCancelCommunication } from '@/sync/ops';

interface AgentQuestionModalProps {
    pending: PendingAgentForm;
    sessionId: string;
    visible: boolean;
    onClose: () => void;
}

/**
 * Full-screen form for the questions an agent is waiting on. Each question
 * offers its options as checkboxes and, when the agent allows it, a field for
 * an answer it did not think of.
 */
export function AgentQuestionModal({ pending, sessionId, visible, onClose }: AgentQuestionModalProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const [drafts, setDrafts] = React.useState<Record<string, AgentQuestionDraft>>({});
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // Start from a clean form every time the modal opens for a new request.
    React.useEffect(() => {
        if (visible) {
            setDrafts({});
            setError(null);
        }
    }, [pending.id, visible]);

    const draftFor = React.useCallback(
        (questionId: string) => drafts[questionId] ?? { options: [], custom: '' },
        [drafts],
    );

    const handleToggle = React.useCallback((questionId: string, label: string, multiSelect: boolean) => {
        setDrafts(previous => ({
            ...previous,
            [questionId]: toggleOption(previous[questionId] ?? { options: [], custom: '' }, label, multiSelect),
        }));
    }, []);

    const handleCustomChange = React.useCallback((questionId: string, custom: string) => {
        setDrafts(previous => ({
            ...previous,
            [questionId]: { ...(previous[questionId] ?? { options: [], custom: '' }), custom },
        }));
    }, []);

    const ready = canSubmit(pending.questions, drafts);

    const handleSubmit = React.useCallback(async () => {
        if (!ready || submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            await sessionAnswerQuestion(
                sessionId,
                pending.id,
                buildAnswers(pending.questions, drafts),
                pending.kind,
            );
            onClose();
        } catch (submitError) {
            // Keep the form open with the answers intact so the user can retry.
            setError(submitError instanceof Error ? submitError.message : t('agentQuestion.submitFailed'));
        } finally {
            setSubmitting(false);
        }
    }, [drafts, onClose, pending, ready, sessionId, submitting]);

    const handleDismiss = React.useCallback(async () => {
        if (submitting) return;
        onClose();
        try {
            await sessionCancelCommunication(sessionId, pending.id, pending.kind);
        } catch {
            // The agent re-asks if the dismissal never lands; nothing to show here.
        }
    }, [onClose, pending.id, pending.kind, sessionId, submitting]);

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="fullScreen"
            onRequestClose={handleDismiss}
        >
            <View style={[styles.container, { paddingTop: safeArea.top }]}>
                <View style={styles.header}>
                    <Pressable onPress={handleDismiss} hitSlop={12} disabled={submitting}>
                        <Text style={styles.headerAction}>{t('common.cancel')}</Text>
                    </Pressable>
                    <Text style={styles.headerTitle}>{t('agentQuestion.title')}</Text>
                    <View style={styles.headerSpacer} />
                </View>

                <ScrollView
                    style={styles.scroll}
                    contentContainerStyle={[styles.scrollContent, { paddingBottom: safeArea.bottom + 96 }]}
                    keyboardShouldPersistTaps="handled"
                >
                    {pending.questions.map((question, index) => {
                        const draft = draftFor(question.id);
                        const multiSelect = question.multiSelect === true;
                        const answered = isQuestionAnswered(question, drafts[question.id]);

                        return (
                            <View key={question.id} style={styles.questionBlock}>
                                <View style={styles.headerChipRow}>
                                    <View style={styles.headerChip}>
                                        <Text style={styles.headerChipText}>{question.header}</Text>
                                    </View>
                                    {!answered && <View style={styles.requiredDot} />}
                                </View>
                                <Text style={styles.questionText}>{question.question}</Text>
                                {multiSelect && (
                                    <Text style={styles.hintText}>{t('agentQuestion.chooseMultiple')}</Text>
                                )}

                                {question.options.map(option => {
                                    const selected = draft.options.includes(option.label);
                                    return (
                                        <Pressable
                                            key={option.label}
                                            style={[styles.option, selected && styles.optionSelected]}
                                            onPress={() => handleToggle(question.id, option.label, multiSelect)}
                                            disabled={submitting}
                                        >
                                            <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                                                {selected && (
                                                    <Ionicons name="checkmark" size={14} color="#fff" />
                                                )}
                                            </View>
                                            <View style={styles.optionText}>
                                                <Text style={styles.optionLabel}>{option.label}</Text>
                                                {option.description ? (
                                                    <Text style={styles.optionDescription}>
                                                        {option.description}
                                                    </Text>
                                                ) : null}
                                            </View>
                                        </Pressable>
                                    );
                                })}

                                {question.allowCustom !== false && (
                                    <View style={styles.customBlock}>
                                        <Text style={styles.customLabel}>{t('agentQuestion.ownAnswer')}</Text>
                                        <TextInput
                                            style={styles.customInput}
                                            value={draft.custom}
                                            onChangeText={value => handleCustomChange(question.id, value)}
                                            placeholder={t('agentQuestion.ownAnswerPlaceholder')}
                                            placeholderTextColor={theme.colors.textSecondary}
                                            multiline
                                            editable={!submitting}
                                            // Focus the first question's field so the keyboard is
                                            // ready for a written answer without another tap.
                                            autoFocus={index === 0 && question.options.length === 0}
                                        />
                                    </View>
                                )}
                            </View>
                        );
                    })}

                    {error && <Text style={styles.errorText}>{error}</Text>}
                </ScrollView>

                <View style={[styles.footer, { paddingBottom: safeArea.bottom + 12 }]}>
                    <Pressable
                        style={[styles.submit, (!ready || submitting) && styles.submitDisabled]}
                        onPress={handleSubmit}
                        disabled={!ready || submitting}
                    >
                        {submitting ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.submitText}>{t('agentQuestion.submit')}</Text>
                        )}
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    headerAction: {
        fontSize: 16,
        color: theme.colors.textLink,
        ...Typography.default(),
    },
    headerTitle: {
        flex: 1,
        textAlign: 'center',
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    headerSpacer: {
        width: 60,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        padding: 16,
        gap: 28,
    },
    questionBlock: {
        gap: 8,
    },
    headerChipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    headerChipText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    requiredDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#FF9500',
    },
    questionText: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    hintText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    option: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        padding: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    optionSelected: {
        borderColor: theme.colors.textLink,
    },
    checkbox: {
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: theme.colors.divider,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    checkboxSelected: {
        backgroundColor: theme.colors.textLink,
        borderColor: theme.colors.textLink,
    },
    optionText: {
        flex: 1,
        gap: 2,
    },
    optionLabel: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    customBlock: {
        gap: 6,
        marginTop: 4,
    },
    customLabel: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    customInput: {
        minHeight: 48,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 15,
        color: theme.colors.text,
        textAlignVertical: 'top',
    },
    errorText: {
        fontSize: 14,
        color: '#FF3B30',
        ...Typography.default(),
    },
    footer: {
        paddingHorizontal: 16,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
    },
    submit: {
        height: 50,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.textLink,
    },
    submitDisabled: {
        opacity: 0.4,
    },
    submitText: {
        fontSize: 16,
        color: '#fff',
        ...Typography.default('semiBold'),
    },
}));
