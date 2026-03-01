import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { sessionAllow } from '@/sync/ops';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';

interface QuestionOption {
    label: string;
    description: string;
    markdown?: string;
}

interface Question {
    question: string;
    header: string;
    options: QuestionOption[];
    multiSelect: boolean;
}

interface AskUserQuestionInput {
    questions: Question[];
}

// Styles MUST be defined outside the component to prevent infinite re-renders
// with react-native-unistyles. The theme is passed as a function parameter.
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
        minHeight: 44, // Minimum touch target for mobile
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
        lineHeight: 20
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    markdownPreview: {
        marginTop: 8,
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 6,
        padding: 10,
    },
    markdownPreviewText: {
        fontFamily: Typography.mono().fontFamily,
        fontSize: 12,
        color: theme.colors.text,
        lineHeight: 18,
    },
    otherTextInput: {
        marginTop: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
        minHeight: 36,
        maxHeight: 120,
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
        minHeight: 44, // Minimum touch target for mobile
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

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
    const [otherTexts, setOtherTexts] = React.useState<Map<number, string>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [isSubmitted, setIsSubmitted] = React.useState(false);

    // Parse input
    const input = tool.input as AskUserQuestionInput | undefined;
    const questions = input?.questions;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
        return null;
    }

    const isRunning = tool.state === 'running';
    const canInteract = isRunning && !isSubmitted;

    // "Other" is represented as sentinel index = options.length
    const getOtherIndex = (q: Question) => q.options.length;

    // Check if all questions have at least one valid selection
    const allQuestionsAnswered = questions.every((q, qIndex) => {
        const selected = selections.get(qIndex);
        if (!selected || selected.size === 0) return false;
        // If "Other" is selected, require non-empty text
        if (selected.has(getOtherIndex(q))) {
            const text = otherTexts.get(qIndex);
            if (!text?.trim()) return false;
        }
        return true;
    });

    const handleOptionToggle = React.useCallback((questionIndex: number, optionIndex: number, multiSelect: boolean) => {
        if (!canInteract) return;

        setSelections(prev => {
            const newMap = new Map(prev);
            const currentSet = newMap.get(questionIndex) || new Set();

            if (multiSelect) {
                // Toggle for multi-select
                const newSet = new Set(currentSet);
                if (newSet.has(optionIndex)) {
                    newSet.delete(optionIndex);
                } else {
                    newSet.add(optionIndex);
                }
                newMap.set(questionIndex, newSet);
            } else {
                // Replace for single-select
                newMap.set(questionIndex, new Set([optionIndex]));
            }

            return newMap;
        });
    }, [canInteract]);

    const handleOtherTextChange = React.useCallback((questionIndex: number, text: string) => {
        setOtherTexts(prev => {
            const newMap = new Map(prev);
            newMap.set(questionIndex, text);
            return newMap;
        });
    }, []);

    const handleSubmit = React.useCallback(async () => {
        if (!sessionId || !allQuestionsAnswered || isSubmitting) return;

        setIsSubmitting(true);

        // HACK: Disable the form immediately by switching to the submitted view.
        // Without this, users could edit their selections while the network calls
        // are in flight, but those edits would be ignored since we've already
        // captured the values above. TODO: Revisit this logic.
        setIsSubmitted(true);

        // Build answers as Record<string, string> keyed by question header
        const answers: Record<string, string> = {};
        questions.forEach((q, qIndex) => {
            const selected = selections.get(qIndex);
            if (selected && selected.size > 0) {
                const otherIndex = getOtherIndex(q);
                const hasOther = selected.has(otherIndex);
                const predefinedLabels = Array.from(selected)
                    .filter(optIndex => optIndex !== otherIndex)
                    .map(optIndex => q.options[optIndex]?.label)
                    .filter(Boolean);

                if (hasOther) {
                    const customText = otherTexts.get(qIndex)?.trim() || '';
                    if (predefinedLabels.length > 0) {
                        // Multi-select: combine predefined labels with custom text
                        answers[q.header] = [...predefinedLabels, customText].join(', ');
                    } else {
                        answers[q.header] = customText;
                    }
                } else {
                    answers[q.header] = predefinedLabels.join(', ');
                }
            }
        });

        try {
            // Approve the permission with answers embedded — no separate sendMessage needed
            if (tool.permission?.id) {
                await sessionAllow(sessionId, tool.permission.id, undefined, undefined, undefined, answers);
            }
        } catch (error) {
            console.error('Failed to submit answer:', error);
        } finally {
            setIsSubmitting(false);
        }
    }, [sessionId, questions, selections, otherTexts, allQuestionsAnswered, isSubmitting, tool.permission?.id]);

    // Show submitted state
    if (isSubmitted || tool.state === 'completed') {
        // Persisted answers from permission (survives re-mount)
        const persistedAnswers = tool.permission?.answers;

        return (
            <ToolSectionView>
                <View style={styles.submittedContainer}>
                    {questions.map((q, qIndex) => {
                        // Build display label from local state
                        const selected = selections.get(qIndex);
                        let displayLabel: string;
                        if (selected && selected.size > 0) {
                            const otherIndex = getOtherIndex(q);
                            const hasOther = selected.has(otherIndex);
                            const predefinedLabels = Array.from(selected)
                                .filter(i => i !== otherIndex)
                                .map(i => q.options[i]?.label)
                                .filter(Boolean);
                            if (hasOther) {
                                const customText = otherTexts.get(qIndex)?.trim() || '';
                                displayLabel = predefinedLabels.length > 0
                                    ? [...predefinedLabels, customText].join(', ')
                                    : customText;
                            } else {
                                displayLabel = predefinedLabels.join(', ');
                            }
                        } else {
                            displayLabel = persistedAnswers?.[q.header] || '-';
                        }
                        return (
                            <View key={qIndex} style={styles.submittedItem}>
                                <Text style={styles.submittedHeader}>{q.header}:</Text>
                                <Text style={styles.submittedValue}>{displayLabel}</Text>
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
                {questions.map((question, qIndex) => {
                    const selectedOptions = selections.get(qIndex) || new Set();
                    const otherIndex = getOtherIndex(question);
                    const isOtherSelected = selectedOptions.has(otherIndex);

                    return (
                        <View key={qIndex} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{question.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{question.question}</Text>
                            <View style={styles.optionsContainer}>
                                {question.options.map((option, oIndex) => {
                                    const isSelected = selectedOptions.has(oIndex);

                                    return (
                                        <View key={oIndex}>
                                            <TouchableOpacity
                                                style={[
                                                    styles.optionButton,
                                                    isSelected && styles.optionButtonSelected,
                                                    !canInteract && styles.optionButtonDisabled,
                                                ]}
                                                onPress={() => handleOptionToggle(qIndex, oIndex, question.multiSelect)}
                                                disabled={!canInteract}
                                                activeOpacity={0.7}
                                            >
                                                {question.multiSelect ? (
                                                    <View style={[
                                                        styles.checkboxOuter,
                                                        isSelected && styles.checkboxOuterSelected,
                                                    ]}>
                                                        {isSelected && (
                                                            <Ionicons name="checkmark" size={14} color="#fff" />
                                                        )}
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
                                                    {option.description && (
                                                        <Text style={styles.optionDescription}>{option.description}</Text>
                                                    )}
                                                </View>
                                            </TouchableOpacity>
                                            {isSelected && option.markdown && (
                                                <View style={styles.markdownPreview}>
                                                    <Text style={styles.markdownPreviewText}>{option.markdown}</Text>
                                                </View>
                                            )}
                                        </View>
                                    );
                                })}

                                {/* "Other" option */}
                                <View>
                                    <TouchableOpacity
                                        style={[
                                            styles.optionButton,
                                            isOtherSelected && styles.optionButtonSelected,
                                            !canInteract && styles.optionButtonDisabled,
                                        ]}
                                        onPress={() => handleOptionToggle(qIndex, otherIndex, question.multiSelect)}
                                        disabled={!canInteract}
                                        activeOpacity={0.7}
                                    >
                                        {question.multiSelect ? (
                                            <View style={[
                                                styles.checkboxOuter,
                                                isOtherSelected && styles.checkboxOuterSelected,
                                            ]}>
                                                {isOtherSelected && (
                                                    <Ionicons name="checkmark" size={14} color="#fff" />
                                                )}
                                            </View>
                                        ) : (
                                            <View style={[
                                                styles.radioOuter,
                                                isOtherSelected && styles.radioOuterSelected,
                                            ]}>
                                                {isOtherSelected && <View style={styles.radioInner} />}
                                            </View>
                                        )}
                                        <View style={styles.optionContent}>
                                            <Text style={styles.optionLabel}>{t('tools.askUserQuestion.other')}</Text>
                                        </View>
                                    </TouchableOpacity>
                                    {isOtherSelected && (
                                        <TextInput
                                            style={styles.otherTextInput}
                                            value={otherTexts.get(qIndex) || ''}
                                            onChangeText={(text) => handleOtherTextChange(qIndex, text)}
                                            placeholder={t('tools.askUserQuestion.otherPlaceholder')}
                                            placeholderTextColor={theme.colors.textSecondary}
                                            multiline
                                            editable={canInteract}
                                            autoFocus
                                            textAlignVertical="top"
                                        />
                                    )}
                                </View>
                            </View>
                        </View>
                    );
                })}

                {canInteract && (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            style={[
                                styles.submitButton,
                                (!allQuestionsAnswered || isSubmitting) && styles.submitButtonDisabled,
                            ]}
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
