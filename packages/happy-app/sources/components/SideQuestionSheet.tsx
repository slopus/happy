import * as React from 'react';
import { View, Text, TextInput, ScrollView, Pressable, Platform, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { t } from '@/text';
import { storage } from '@/sync/storage';
import { sessionSideQuestion } from '@/sync/ops';
import {
    SIDE_QUESTION_UNSUPPORTED_ERROR,
    type SideQuestionTurn,
    type SideQuestionUnavailableReason,
} from '@/sync/sideQuestion';
import { getDuplicateSheetFrame } from '@/utils/duplicateSheetLayout';
import { MarkdownView } from './markdown/MarkdownView';
import { MobileGlassSurface } from './MobileGlass';

export interface SideQuestionSheetProps {
    sessionId: string;
    /** The question typed after `/btw`; empty opens the sheet ready to type one. */
    initialQuestion: string;
    /** Injected by the modal infra. */
    onClose?: () => void;
}

type ExchangeState =
    | { status: 'asking' }
    | { status: 'answered'; response: string | null; synthetic: boolean }
    /** Expected states the user can act on, such as Claude running in the terminal. */
    | { status: 'notice'; message: string }
    | { status: 'failed'; message: string };

type Exchange = {
    question: string;
    state: ExchangeState;
};

/**
 * Opens the side-question sheet for `/btw`. The thread lives only as long as
 * the sheet: closing it drops any question still being answered.
 */
export function showSideQuestionSheet(sessionId: string, initialQuestion: string) {
    Modal.show({ component: SideQuestionSheet, props: { sessionId, initialQuestion } });
}

/**
 * Claude Code's `/btw`: ask the session's running Claude a quick question about
 * the conversation. Answers come from the current context without tools and
 * are never added to the chat, so they can be asked mid-turn. Follow-ups carry
 * the earlier exchanges of this sheet, the way Claude Code's own panel does.
 */
export const SideQuestionSheet = React.memo(function SideQuestionSheet(props: SideQuestionSheetProps) {
    const { sessionId, initialQuestion, onClose } = props;
    const { theme } = useUnistyles();
    const windowSize = useWindowDimensions();
    const sheetFrame = React.useMemo(
        () => getDuplicateSheetFrame(windowSize),
        [windowSize.width, windowSize.height],
    );

    const [exchanges, setExchanges] = React.useState<Exchange[]>([]);
    const [draft, setDraft] = React.useState('');
    const scrollRef = React.useRef<ScrollView>(null);
    const controllerRef = React.useRef<AbortController | null>(null);

    // Closing the sheet abandons the question in flight
    React.useEffect(() => () => controllerRef.current?.abort(), []);

    const ask = React.useCallback((question: string, previous: Exchange[]) => {
        const history: SideQuestionTurn[] = previous.flatMap((exchange) => (
            exchange.state.status === 'answered' && exchange.state.response !== null && !exchange.state.synthetic
                ? [{ question: exchange.question, response: exchange.state.response }]
                : []
        ));
        const index = previous.length;
        const settle = (state: ExchangeState) => {
            setExchanges((current) => current.map((exchange, i) => (i === index ? { ...exchange, state } : exchange)));
        };
        setExchanges([...previous, { question, state: { status: 'asking' } }]);

        // An offline session would make the server wait 15 s and then answer
        // like a CLI that predates side questions
        if (storage.getState().sessions[sessionId]?.presence !== 'online') {
            settle({ status: 'notice', message: t('sideQuestion.offline') });
            return;
        }

        const controller = new AbortController();
        controllerRef.current = controller;
        sessionSideQuestion(sessionId, question, history, controller.signal).then((result) => {
            if (controller.signal.aborted) {
                return;
            }
            if (result.status === 'answered') {
                settle({ status: 'answered', response: result.answer.response, synthetic: result.answer.synthetic });
            } else if (result.status === 'unavailable') {
                settle({ status: 'notice', message: describeUnavailable(result.reason) });
            } else {
                settle({ status: 'answered', response: null, synthetic: false });
            }
        }, (error: unknown) => {
            if (!controller.signal.aborted) {
                settle(describeFailure(sessionId, error));
            }
        });
    }, [sessionId]);

    React.useEffect(() => {
        // Only the question the sheet was opened with is asked on mount
        if (initialQuestion) {
            ask(initialQuestion, []);
        }
    }, []);

    const asking = exchanges.some((exchange) => exchange.state.status === 'asking');
    const canSend = draft.trim().length > 0 && !asking;
    const handleSend = React.useCallback(() => {
        const question = draft.trim();
        if (!question || asking) {
            return;
        }
        setDraft('');
        ask(question, exchanges);
    }, [draft, asking, exchanges, ask]);

    return (
        <MobileGlassSurface
            enabled={Platform.OS !== 'web'}
            nativeEffect
            glassEffectStyle="regular"
            intensity={88}
            tintColor={theme.colors.glass.overlayTint}
            style={[styles.sheet, sheetFrame]}
        >
            <View style={styles.header}>
                <View style={styles.headerText}>
                    <Text style={styles.title}>{t('sideQuestion.title')}</Text>
                    <Text style={styles.subtitle}>{t('sideQuestion.subtitle')}</Text>
                </View>
                <Pressable
                    onPress={onClose}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('sideQuestion.close')}
                    style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                >
                    <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            {exchanges.length > 0 && (
                <ScrollView
                    ref={scrollRef}
                    style={styles.thread}
                    contentContainerStyle={styles.threadContent}
                    keyboardShouldPersistTaps="handled"
                    onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
                >
                    {exchanges.map((exchange, index) => (
                        <View key={index} style={styles.exchange}>
                            <View style={styles.questionBubble}>
                                <Text style={styles.questionText} selectable>{exchange.question}</Text>
                            </View>
                            {exchange.state.status === 'asking' ? (
                                <View style={styles.answering}>
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    <Text style={styles.mutedText}>{t('sideQuestion.answering')}</Text>
                                </View>
                            ) : exchange.state.status === 'notice' ? (
                                <Text style={styles.mutedText}>{exchange.state.message}</Text>
                            ) : exchange.state.status === 'failed' ? (
                                <Text style={styles.failedText} selectable>{exchange.state.message}</Text>
                            ) : exchange.state.response === null ? (
                                <Text style={styles.mutedText}>{t('sideQuestion.noAnswer')}</Text>
                            ) : exchange.state.synthetic ? (
                                // Claude Code's stand-in for an answer the model could not give
                                <Text style={styles.mutedText}>{exchange.state.response}</Text>
                            ) : (
                                <MarkdownView markdown={exchange.state.response} sessionId={sessionId} />
                            )}
                        </View>
                    ))}
                </ScrollView>
            )}

            <View style={styles.composer}>
                <TextInput
                    style={styles.input}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={exchanges.length > 0 ? t('sideQuestion.followUpPlaceholder') : t('sideQuestion.placeholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    autoFocus={!initialQuestion}
                    returnKeyType="send"
                    submitBehavior="submit"
                    onSubmitEditing={handleSend}
                />
                <Pressable
                    onPress={handleSend}
                    disabled={!canSend}
                    accessibilityRole="button"
                    accessibilityLabel={t('sideQuestion.send')}
                    style={({ pressed }) => [styles.sendButton, !canSend && styles.disabled, pressed && styles.pressed]}
                >
                    <Ionicons name="arrow-up" size={18} color={theme.colors.button.primary.tint} />
                </Pressable>
            </View>
        </MobileGlassSurface>
    );
});

function describeUnavailable(reason: SideQuestionUnavailableReason): string {
    return reason === 'local' ? t('sideQuestion.terminalMode') : t('sideQuestion.notStarted');
}

function describeFailure(sessionId: string, error: unknown): ExchangeState {
    if (storage.getState().sessions[sessionId]?.presence !== 'online') {
        return { status: 'notice', message: t('sideQuestion.offline') };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === SIDE_QUESTION_UNSUPPORTED_ERROR) {
        return { status: 'notice', message: t('sideQuestion.cliOutdated') };
    }
    return { status: 'failed', message: t('sideQuestion.failed', { error: message }) };
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        alignSelf: 'center',
        minWidth: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    headerText: {
        flex: 1,
    },
    title: {
        fontSize: 17,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 4,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    closeButton: {
        padding: 2,
    },
    thread: {
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
    },
    threadContent: {
        paddingHorizontal: 20,
        paddingVertical: 12,
        gap: 16,
    },
    exchange: {
        gap: 8,
    },
    questionBubble: {
        alignSelf: 'flex-end',
        maxWidth: '90%',
        backgroundColor: theme.colors.userMessageBackground,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
    },
    questionText: {
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.text,
    },
    answering: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    mutedText: {
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.textSecondary,
    },
    failedText: {
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.textDestructive,
    },
    composer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    input: {
        flex: 1,
        height: 40,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 12,
        fontSize: 15,
        color: theme.colors.text,
        backgroundColor: theme.colors.input.background,
    },
    sendButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
    disabled: {
        opacity: 0.4,
    },
    pressed: {
        opacity: 0.7,
    },
}));
