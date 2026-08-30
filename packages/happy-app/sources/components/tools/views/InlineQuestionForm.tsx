import * as React from 'react';
import { ActivityIndicator, Platform, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { ToolSectionView } from '../ToolSectionView';

export interface InlineQuestionOption {
    label: string;
    description?: string | null;
}

export interface InlineQuestion {
    id: string;
    question: string;
    header: string;
    options: InlineQuestionOption[];
    multiSelect?: boolean | null;
    required?: boolean | null;
}

export type InlineQuestionAnswers = Record<string, string[]>;

interface InlineQuestionFormProps {
    questions: InlineQuestion[];
    canInteract: boolean;
    submittedAnswers?: InlineQuestionAnswers | null;
    onSubmit: (answers: InlineQuestionAnswers) => Promise<void>;
}

// This is the shared choice form used by both Claude's AskUserQuestion tool and
// agent communications such as Codex/Happy request_user_input. Transport and
// answer payload differences stay in the small wrappers around this view.
export const InlineQuestionForm = React.memo<InlineQuestionFormProps>((props) => {
    const { questions, onSubmit } = props;
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<string, Set<number>>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [locallySubmittedAnswers, setLocallySubmittedAnswers] = React.useState<InlineQuestionAnswers | null>(null);
    const questionKey = questions.map(question => question.id).join('\u0000');

    React.useEffect(() => {
        setSelections(new Map());
        setLocallySubmittedAnswers(null);
        setIsSubmitting(false);
    }, [questionKey]);

    const submittedAnswers = props.submittedAnswers ?? locallySubmittedAnswers;
    const canInteract = props.canInteract && submittedAnswers === null;
    const allQuestionsAnswered = questions.every((question) => {
        if (question.required === false) return true;
        return (selections.get(question.id)?.size ?? 0) > 0;
    });

    const handleOptionToggle = React.useCallback((question: InlineQuestion, optionIndex: number) => {
        if (!canInteract) return;

        setSelections(previous => {
            const next = new Map(previous);
            const current = previous.get(question.id) ?? new Set<number>();
            if (question.multiSelect) {
                const selected = new Set(current);
                if (selected.has(optionIndex)) {
                    selected.delete(optionIndex);
                } else {
                    selected.add(optionIndex);
                }
                next.set(question.id, selected);
            } else {
                next.set(question.id, new Set([optionIndex]));
            }
            return next;
        });
    }, [canInteract]);

    const handleSubmit = React.useCallback(async () => {
        if (!allQuestionsAnswered || isSubmitting) return;

        const answers: InlineQuestionAnswers = {};
        for (const question of questions) {
            const selected = selections.get(question.id);
            if (!selected || selected.size === 0) continue;
            answers[question.id] = Array.from(selected)
                .map(optionIndex => question.options[optionIndex]?.label)
                .filter((label): label is string => Boolean(label));
        }

        setIsSubmitting(true);
        setLocallySubmittedAnswers(answers);
        try {
            await onSubmit(answers);
        } catch (error) {
            setLocallySubmittedAnswers(null);
            console.error('Failed to submit question answer:', error);
        } finally {
            setIsSubmitting(false);
        }
    }, [allQuestionsAnswered, isSubmitting, onSubmit, questions, selections]);

    if (submittedAnswers) {
        return (
            <ToolSectionView>
                <View style={styles.submittedContainer}>
                    {questions.map(question => (
                        <View key={question.id} style={styles.submittedItem}>
                            <Text style={styles.submittedHeader}>{question.header}:</Text>
                            <Text style={styles.submittedValue}>
                                {submittedAnswers[question.id]?.join(', ') || '—'}
                            </Text>
                        </View>
                    ))}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {questions.map(question => {
                    const selectedOptions = selections.get(question.id) ?? new Set<number>();
                    return (
                        <View key={question.id} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{question.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{question.question}</Text>
                            <View style={styles.optionsContainer}>
                                {question.options.map((option, optionIndex) => {
                                    const isSelected = selectedOptions.has(optionIndex);
                                    return (
                                        <TouchableOpacity
                                            key={`${question.id}:${optionIndex}`}
                                            style={[
                                                styles.optionButton,
                                                isSelected && styles.optionButtonSelected,
                                                !canInteract && styles.optionButtonDisabled,
                                            ]}
                                            onPress={() => handleOptionToggle(question, optionIndex)}
                                            disabled={!canInteract}
                                            activeOpacity={0.7}
                                        >
                                            {question.multiSelect ? (
                                                <View style={[
                                                    styles.checkboxOuter,
                                                    isSelected && styles.checkboxOuterSelected,
                                                ]}>
                                                    {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                                                </View>
                                            ) : (
                                                <View style={[
                                                    styles.radioOuter,
                                                    isSelected && styles.radioOuterSelected,
                                                ]}>
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
                            style={[
                                styles.submitButton,
                                allQuestionsAnswered && !isSubmitting && styles.submitButtonReady,
                                (!allQuestionsAnswered || isSubmitting) && styles.submitButtonDisabled,
                            ]}
                            onPress={handleSubmit}
                            disabled={!allQuestionsAnswered || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivityIndicator
                                    size="small"
                                    color={Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text })}
                                />
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

// Kept visually identical to the existing AskUserQuestion experience.
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
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
        minHeight: 44,
    },
    optionButtonSelected: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, default: theme.colors.surfaceHighest }),
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
        backgroundColor: Platform.select({ web: theme.colors.button.primary.background, default: theme.colors.surfaceHighest }),
        borderWidth: Platform.select({ web: 0, default: 1 }),
        borderColor: theme.colors.divider,
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
    submitButtonReady: {
        borderColor: theme.colors.radio.active,
    },
    submitButtonText: {
        color: Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text }),
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