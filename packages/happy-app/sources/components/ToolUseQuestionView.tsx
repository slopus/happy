import { ToolSectionView } from '@/components/tools/ToolSectionView';
import { sessionAnswerQuestion } from '@/sync/ops';
import { t } from '@/text';
import type { QuestionRequest } from '@slopus/happy-sync';
import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export interface ToolUseQuestionViewProps {
    question: QuestionRequest;
    sessionId: string;
    toolInput?: unknown;
}

export const ToolUseQuestionView = React.memo<ToolUseQuestionViewProps>(({ question, sessionId, toolInput }) => {
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const questions = question.block.questions;
    if (!questions || questions.length === 0) {
        return null;
    }

    const canInteract = !question.resolved && !isSubmitting;

    const allQuestionsAnswered = questions.every((_, qIndex) => {
        const selected = selections.get(qIndex);
        return selected && selected.size > 0;
    });

    const handleOptionToggle = React.useCallback((questionIndex: number, optionIndex: number, multiSelect: boolean) => {
        if (!canInteract) return;
        setSelections((prev) => {
            const next = new Map(prev);
            const current = next.get(questionIndex) || new Set<number>();
            if (multiSelect) {
                const updated = new Set(current);
                if (updated.has(optionIndex)) {
                    updated.delete(optionIndex);
                } else {
                    updated.add(optionIndex);
                }
                next.set(questionIndex, updated);
            } else {
                next.set(questionIndex, new Set([optionIndex]));
            }
            return next;
        });
    }, [canInteract]);

    const handleSubmit = React.useCallback(async () => {
        if (!allQuestionsAnswered || isSubmitting) return;
        setIsSubmitting(true);

        const structuredAnswers: string[][] = questions.map((q, qIndex) => {
            const selected = selections.get(qIndex);
            if (!selected) return [];
            return Array.from(selected)
                .map((optIndex) => q.options[optIndex]?.label)
                .filter((label): label is string => Boolean(label));
        });

        try {
            await sessionAnswerQuestion(sessionId, question.questionId, structuredAnswers);
        } catch (error) {
            console.error('Failed to submit answer:', error);
        } finally {
            setIsSubmitting(false);
        }
    }, [sessionId, question.questionId, questions, selections, allQuestionsAnswered, isSubmitting]);

    // Resolved state: show submitted answers
    if (question.resolved && question.answers) {
        return (
            <ToolSectionView>
                <View style={styles.submittedContainer}>
                    {questions.map((q, qIndex) => {
                        const answer = question.answers?.[qIndex];
                        return (
                            <View key={qIndex} style={styles.submittedItem}>
                                <Text style={styles.submittedHeader}>{q.header}:</Text>
                                <Text style={styles.submittedValue}>{answer?.join(', ') || '-'}</Text>
                            </View>
                        );
                    })}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {questions.map((q, qIndex) => {
                    const selectedOptions = selections.get(qIndex) || new Set<number>();
                    const isMulti = q.multiple ?? false;

                    return (
                        <View key={qIndex} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{q.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{q.question}</Text>
                            <View style={styles.optionsContainer}>
                                {q.options.map((option, oIndex) => {
                                    const isSelected = selectedOptions.has(oIndex);
                                    return (
                                        <TouchableOpacity
                                            key={oIndex}
                                            style={[
                                                styles.optionButton,
                                                isSelected && styles.optionButtonSelected,
                                                !canInteract && styles.optionButtonDisabled,
                                            ]}
                                            onPress={() => handleOptionToggle(qIndex, oIndex, isMulti)}
                                            disabled={!canInteract}
                                            activeOpacity={0.7}
                                        >
                                            {isMulti ? (
                                                <View style={[styles.checkboxOuter, isSelected && styles.checkboxOuterSelected]}>
                                                    {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                                                </View>
                                            ) : (
                                                <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
                                                    {isSelected && <View style={styles.radioInner} />}
                                                </View>
                                            )}
                                            <View style={styles.optionContent}>
                                                <Text style={styles.optionLabel}>{option.label}</Text>
                                                {option.description ? (
                                                    <Text style={styles.optionDescription}>{option.description}</Text>
                                                ) : null}
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                    );
                })}

                {canInteract && (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            style={[styles.submitButton, (!allQuestionsAnswered || isSubmitting) && styles.submitButtonDisabled]}
                            onPress={handleSubmit}
                            disabled={!allQuestionsAnswered || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                            ) : (
                                <Text style={styles.submitButtonText}>{t('tools.askUserQuestion.submit')}</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    questionSection: {
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginBottom: 4,
    },
    headerText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 8,
    },
    optionsContainer: {
        gap: 4,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
        minHeight: 44,
    },
    optionButtonSelected: {
        backgroundColor: theme.colors.surfaceHigh,
        borderColor: theme.colors.radio.active,
    },
    optionButtonDisabled: {
        opacity: 0.6,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    radioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    checkboxOuter: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    checkboxOuterSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
    optionContent: {
        flex: 1,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
        justifyContent: 'flex-end',
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 14,
        fontWeight: '600',
    },
    submittedContainer: {
        gap: 8,
    },
    submittedItem: {
        flexDirection: 'row',
        gap: 8,
    },
    submittedHeader: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    submittedValue: {
        fontSize: 13,
        color: theme.colors.text,
        flex: 1,
    },
}));
