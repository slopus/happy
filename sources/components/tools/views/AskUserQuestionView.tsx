import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { sessionDeny } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';

interface QuestionOption {
    label: string;
    description: string;
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

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
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

    // Check if all questions have at least one selection
    const allQuestionsAnswered = questions.every((_, qIndex) => {
        const selected = selections.get(qIndex);
        return selected && selected.size > 0;
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

    const handleSubmit = React.useCallback(async () => {
        if (!sessionId || !allQuestionsAnswered || isSubmitting) return;

        setIsSubmitting(true);

        // Format answers as readable text
        const responseLines: string[] = [];
        questions.forEach((q, qIndex) => {
            const selected = selections.get(qIndex);
            if (selected && selected.size > 0) {
                const selectedLabels = Array.from(selected)
                    .map(optIndex => q.options[optIndex]?.label)
                    .filter(Boolean)
                    .join(', ');
                responseLines.push(`${q.header}: ${selectedLabels}`);
            }
        });

        const responseText = responseLines.join('\n');

        try {
            // TODO: The proper fix is to update happy-cli to not require permission for AskUserQuestion,
            // or to accept answers via the permission RPC. For now, we deny the permission (which cancels
            // the tool without side effects) and send answers as a regular user message.
            if (tool.permission?.id) {
                await sessionDeny(sessionId, tool.permission.id);
            }
            await sync.sendMessage(sessionId, responseText);
            setIsSubmitted(true);
        } catch (error) {
            console.error('Failed to submit answer:', error);
        } finally {
            setIsSubmitting(false);
        }
    }, [sessionId, questions, selections, allQuestionsAnswered, isSubmitting, tool.permission?.id]);

    const styles = StyleSheet.create({
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
    });

    // Show submitted state
    if (isSubmitted || tool.state === 'completed') {
        return (
            <ToolSectionView>
                <View style={styles.submittedContainer}>
                    {questions.map((q, qIndex) => {
                        const selected = selections.get(qIndex);
                        const selectedLabels = selected
                            ? Array.from(selected)
                                .map(optIndex => q.options[optIndex]?.label)
                                .filter(Boolean)
                                .join(', ')
                            : '-';
                        return (
                            <View key={qIndex} style={styles.submittedItem}>
                                <Text style={styles.submittedHeader}>{q.header}:</Text>
                                <Text style={styles.submittedValue}>{selectedLabels}</Text>
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
                                        <TouchableOpacity
                                            key={oIndex}
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
