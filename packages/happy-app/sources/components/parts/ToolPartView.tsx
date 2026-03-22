import * as React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { type v3 } from '@slopus/happy-sync';
import { sessionAnswerQuestion } from '@/sync/ops';
import { CodeView } from '../CodeView';
import { ToolSectionView } from '../tools/ToolSectionView';
import { PermissionFooter } from '../tools/PermissionFooter';
import {
    getPendingQuestionBlock,
    getToolPartStatusLabel,
    getToolPartSubtitle,
    getToolPartTitle,
    getToolPermissionState,
    getToolPreviewText,
    getToolResultText,
    getResolvedQuestionBlock,
} from './toolPartMeta';

function getToolIcon(toolName: string, color: string) {
    const lower = toolName.toLowerCase();

    if (lower.includes('bash') || lower.includes('execute')) {
        return <Octicons name="terminal" size={18} color={color} />;
    }

    if (lower.includes('read') || lower.includes('grep') || lower.includes('glob') || lower === 'ls') {
        return <Octicons name="eye" size={18} color={color} />;
    }

    if (lower.includes('edit') || lower.includes('write') || lower.includes('patch') || lower.includes('diff')) {
        return <Octicons name="file-diff" size={18} color={color} />;
    }

    if (lower.includes('web') || lower.includes('fetch')) {
        return <Ionicons name="globe-outline" size={18} color={color} />;
    }

    if (lower.includes('todo')) {
        return <Ionicons name="checkbox-outline" size={18} color={color} />;
    }

    if (lower.includes('task')) {
        return <Octicons name="rocket" size={18} color={color} />;
    }

    if (lower.includes('question') || lower.includes('askuser')) {
        return <Ionicons name="help-circle-outline" size={18} color={color} />;
    }

    return <Ionicons name="construct-outline" size={18} color={color} />;
}

function ToolPartStatusIcon(props: { part: v3.ToolPart }) {
    const { theme } = useUnistyles();

    switch (props.part.state.status) {
        case 'pending':
        case 'running':
        case 'blocked':
            return <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
        case 'completed':
            return <Ionicons name="checkmark-circle" size={18} color={theme.colors.success} />;
        case 'error':
            return <Ionicons name="alert-circle-outline" size={18} color={theme.colors.warning} />;
    }
}

export const ToolPartHeader = React.memo((props: { part: v3.ToolPart }) => {
    const title = getToolPartTitle(props.part);
    const subtitle = getToolPartSubtitle(props.part);

    return (
        <View style={styles.headerTitle}>
            <Text style={styles.headerTitleText} numberOfLines={1}>{title}</Text>
            {subtitle ? (
                <Text style={styles.headerSubtitleText} numberOfLines={1}>{subtitle}</Text>
            ) : null}
        </View>
    );
});

export const ToolPartStatusIndicator = React.memo((props: { part: v3.ToolPart }) => (
    <View style={styles.headerStatus}>
        <ToolPartStatusIcon part={props.part} />
    </View>
));

const ToolQuestionView = React.memo((props: {
    block: v3.QuestionBlock | v3.ResolvedQuestionBlock;
    sessionId?: string;
    readOnly?: boolean;
}) => {
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const readOnly = props.readOnly ?? 'answers' in props.block;

    const allAnswered = props.block.questions.every((_, index) => {
        const selected = selections.get(index);
        return selected && selected.size > 0;
    });

    const toggleOption = React.useCallback((questionIndex: number, optionIndex: number, multiple: boolean) => {
        if (readOnly || isSubmitting) {
            return;
        }

        setSelections((current) => {
            const next = new Map(current);
            const existing = next.get(questionIndex) ?? new Set<number>();

            if (multiple) {
                const updated = new Set(existing);
                if (updated.has(optionIndex)) {
                    updated.delete(optionIndex);
                } else {
                    updated.add(optionIndex);
                }
                next.set(questionIndex, updated);
                return next;
            }

            next.set(questionIndex, new Set([optionIndex]));
            return next;
        });
    }, [isSubmitting, readOnly]);

    const submitAnswers = React.useCallback(async () => {
        if (readOnly || !props.sessionId || isSubmitting || !allAnswered) {
            return;
        }

        setIsSubmitting(true);
        try {
            const answers = props.block.questions.map((question, questionIndex) => {
                const selected = selections.get(questionIndex) ?? new Set<number>();
                return Array.from(selected)
                    .map((optionIndex) => question.options[optionIndex]?.label)
                    .filter((label): label is string => Boolean(label));
            });

            await sessionAnswerQuestion(props.sessionId, props.block.id, answers);
        } finally {
            setIsSubmitting(false);
        }
    }, [allAnswered, isSubmitting, props.block, props.sessionId, readOnly, selections]);

    const resolvedAnswers = 'answers' in props.block ? props.block.answers : null;

    return (
        <View style={styles.questionContainer}>
            {props.block.questions.map((question, questionIndex) => {
                const selected = selections.get(questionIndex) ?? new Set<number>();
                return (
                    <View key={`${props.block.id}-${questionIndex}`} style={styles.questionGroup}>
                        <Text style={styles.questionHeader}>{question.header}</Text>
                        <Text style={styles.questionText}>{question.question}</Text>
                        <View style={styles.optionList}>
                            {question.options.map((option, optionIndex) => {
                                const isSelected = readOnly
                                    ? Boolean(resolvedAnswers?.[questionIndex]?.includes(option.label))
                                    : selected.has(optionIndex);
                                return (
                                    <TouchableOpacity
                                        key={`${questionIndex}-${optionIndex}`}
                                        disabled={readOnly || isSubmitting}
                                        onPress={() => toggleOption(questionIndex, optionIndex, question.multiple === true)}
                                        activeOpacity={0.8}
                                        style={[
                                            styles.optionButton,
                                            isSelected && styles.optionButtonSelected,
                                        ]}
                                    >
                                        <Text style={styles.optionLabel}>{option.label}</Text>
                                        <Text style={styles.optionDescription}>{option.description}</Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    </View>
                );
            })}

            {!readOnly ? (
                <TouchableOpacity
                    disabled={!allAnswered || isSubmitting}
                    onPress={submitAnswers}
                    activeOpacity={0.85}
                    style={[
                        styles.submitButton,
                        (!allAnswered || isSubmitting) && styles.submitButtonDisabled,
                    ]}
                >
                    {isSubmitting ? (
                        <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={styles.submitButtonText}>Submit answer</Text>
                    )}
                </TouchableOpacity>
            ) : null}
        </View>
    );
});

export const ToolPartView = React.memo((props: {
    part: v3.ToolPart;
    sessionId: string;
    messageId: string;
    expanded?: boolean;
}) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const expanded = props.expanded === true;
    const title = getToolPartTitle(props.part);
    const subtitle = getToolPartSubtitle(props.part);
    const statusLabel = getToolPartStatusLabel(props.part);
    const preview = getToolPreviewText(props.part);
    const resultText = getToolResultText(props.part);
    const questionBlock = getPendingQuestionBlock(props.part);
    const resolvedQuestionBlock = getResolvedQuestionBlock(props.part);
    const permission = getToolPermissionState(props.part);

    const openDetail = React.useCallback(() => {
        if (expanded) {
            return;
        }

        router.push({
            pathname: '/session/[id]/message/[messageId]',
            params: {
                id: props.sessionId,
                messageId: props.messageId,
                partId: props.part.id as string,
            },
        });
    }, [expanded, props.messageId, props.part.id, props.sessionId, router]);

    const summary = (
        <>
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <View style={styles.iconContainer}>
                        {getToolIcon(props.part.tool, theme.colors.textSecondary)}
                    </View>
                    <View style={styles.titleContainer}>
                        <Text style={styles.title} numberOfLines={1}>{title}</Text>
                        {subtitle ? (
                            <Text style={styles.subtitle} numberOfLines={expanded ? 0 : 1}>{subtitle}</Text>
                        ) : null}
                    </View>
                </View>
                <View style={styles.headerRight}>
                    <Text style={styles.statusLabel}>{statusLabel}</Text>
                    <ToolPartStatusIcon part={props.part} />
                </View>
            </View>

            {preview && !expanded ? (
                <Text style={styles.preview}>{preview}</Text>
            ) : null}
        </>
    );

    const interactiveContent = (
        <>
            {questionBlock ? (
                <ToolSectionView title="Question">
                    <ToolQuestionView block={questionBlock} sessionId={props.sessionId} />
                </ToolSectionView>
            ) : null}

            {resolvedQuestionBlock ? (
                <ToolSectionView title="Answer">
                    <ToolQuestionView block={resolvedQuestionBlock} readOnly />
                </ToolSectionView>
            ) : null}

            {permission ? (
                <PermissionFooter
                    permission={permission}
                    sessionId={props.sessionId}
                    toolName={props.part.tool}
                    toolInput={props.part.state.input}
                    metadata={null}
                />
            ) : null}

            {expanded ? (
                <>
                    <ToolSectionView title="Input">
                        <CodeView code={JSON.stringify(props.part.state.input, null, 2)} />
                    </ToolSectionView>

                    {resultText ? (
                        <ToolSectionView title={props.part.state.status === 'error' ? 'Error' : 'Output'}>
                            <CodeView code={resultText} />
                        </ToolSectionView>
                    ) : null}

                    {!resultText && props.part.state.status === 'completed' ? (
                        <Text style={styles.emptyState}>Completed with no output.</Text>
                    ) : null}
                </>
            ) : null}
        </>
    );

    return (
        <View style={[styles.container, expanded && styles.expandedContainer]}>
            {expanded ? (
                <>
                    {summary}
                    {interactiveContent}
                </>
            ) : (
                <>
                    <TouchableOpacity activeOpacity={0.85} onPress={openDetail}>
                        {summary}
                    </TouchableOpacity>
                    {interactiveContent}
                </>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 8,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    expandedContainer: {
        marginHorizontal: 0,
        borderWidth: 0,
        backgroundColor: 'transparent',
    },
    header: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        gap: 10,
    },
    iconContainer: {
        width: 28,
        height: 28,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
    },
    titleContainer: {
        flexShrink: 1,
        gap: 2,
    },
    title: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
    },
    subtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    statusLabel: {
        fontSize: 12,
        fontWeight: '500',
        color: theme.colors.textSecondary,
    },
    preview: {
        paddingHorizontal: 12,
        paddingBottom: 10,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    emptyState: {
        marginHorizontal: 12,
        marginBottom: 12,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    headerTitle: {
        alignItems: 'center',
        justifyContent: 'center',
        maxWidth: 220,
    },
    headerTitleText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    headerSubtitleText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    headerStatus: {
        width: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    questionContainer: {
        gap: 12,
    },
    questionGroup: {
        gap: 8,
    },
    questionHeader: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
    },
    optionList: {
        gap: 6,
    },
    optionButton: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 10,
        gap: 4,
    },
    optionButtonSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.surfaceHigh,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    submitButton: {
        alignSelf: 'flex-end',
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        minWidth: 132,
        alignItems: 'center',
        justifyContent: 'center',
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 14,
        fontWeight: '600',
    },
}));
