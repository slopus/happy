import * as React from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AsyncQuestion, AsyncQuestionAction, AsyncQuestionResponse } from '@slopus/happy-wire';
import { t } from '@/text';

type Props = {
    itemId: string;
    questions: AsyncQuestion[];
    response?: AsyncQuestionResponse;
    readOnly?: boolean;
    supported: boolean;
    onAction: (action: AsyncQuestionAction) => Promise<AsyncQuestionResponse>;
};

/** Owns only its answer editor. It never reads or replaces the main composer. */
export const AsyncQuestionCard = React.memo(function AsyncQuestionCard(props: Props) {
    const { theme } = useUnistyles();
    const [selected, setSelected] = React.useState<Array<number | null>>(() => props.questions.map(q => q.options?.length ? 0 : null));
    const [custom, setCustom] = React.useState(() => props.questions.map(() => ''));
    const [focused, setFocused] = React.useState<number | null>(null);
    const [collapsed, setCollapsed] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(false);
    const [localResponse, setLocalResponse] = React.useState<AsyncQuestionResponse>();
    const pending = React.useRef(false);
    const generation = React.useRef(0);
    React.useEffect(() => () => { generation.current++; }, []);
    const response = localResponse && (!props.response || localResponse.updatedAt >= props.response.updatedAt) ? localResponse : props.response;
    const disabled = Boolean(props.readOnly || !props.supported || busy || response);
    const answers = props.questions.map((question, index) => custom[index]?.trim()
        || (selected[index] == null ? '' : question.options?.[selected[index]!] ?? ''));

    const submit = async (action: 'answer' | 'dismiss') => {
        if (disabled || pending.current || (action === 'answer' && answers.some(answer => !answer))) return;
        pending.current = true;
        const owner = generation.current;
        setBusy(true); setError(false);
        try {
            const result = await props.onAction(action === 'answer'
                ? { itemId: props.itemId, action, answers } : { itemId: props.itemId, action });
            if (owner === generation.current) setLocalResponse(result);
        } catch {
            if (owner === generation.current) setError(true);
        } finally {
            pending.current = false;
            if (owner === generation.current) setBusy(false);
        }
    };
    const status = response?.status;
    return <View testID="async-question-card" style={styles.card}>
        <View style={styles.header}>
            <Ionicons name="help-circle-outline" size={18} color={theme.colors.textSecondary} />
            <Text style={styles.label}>{t('agentInput.asyncQuestion.title')}</Text>
            {status && <Text accessibilityLiveRegion="polite" style={styles.status}>
                {t(`agentInput.asyncQuestion.${status}`)}
            </Text>}
            <QuestionPressable testID="async-question-toggle" accessibilityRole="button"
                accessibilityLabel={collapsed ? t('agentInput.asyncQuestion.expand') : t('agentInput.asyncQuestion.later')}
                accessibilityState={{ expanded: !collapsed }} onPress={() => setCollapsed(value => !value)}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                <Ionicons name={collapsed ? 'chevron-down' : 'chevron-up'} size={18} color={theme.colors.textSecondary} />
            </QuestionPressable>
        </View>
        {collapsed ? <Text numberOfLines={2} style={styles.title}>{props.questions[0]?.title}</Text> : <>
            {!status && <Text style={styles.hint}>{t('agentInput.asyncQuestion.hint')}</Text>}
            {props.questions.map((question, index) => <View key={index} style={styles.question}>
                <Text selectable style={styles.title}>{question.title}</Text>
                {status ? <>
                    {response.answers?.[index] && <Text selectable style={styles.answer}>{response.answers[index]}</Text>}
                </> : <>
                    <View accessibilityRole="radiogroup">
                        {question.options?.map((option, optionIndex) => {
                            const checked = selected[index] === optionIndex && !custom[index]?.trim();
                            return <QuestionPressable key={optionIndex} testID={`async-question-option-${index}-${optionIndex}`}
                                accessibilityRole="radio" accessibilityLabel={option} accessibilityState={{ checked, disabled }}
                                disabled={disabled} onPress={() => {
                                    setSelected(values => values.map((value, i) => i === index ? optionIndex : value));
                                    setCustom(values => values.map((value, i) => i === index ? '' : value));
                                }} style={({ pressed }) => [styles.option, checked && styles.selected, pressed && styles.pressed]}>
                                <Ionicons name={checked ? 'radio-button-on' : 'radio-button-off'} size={18} color={checked ? theme.colors.accent : theme.colors.textSecondary} />
                                <Text style={styles.optionText}>{option}</Text>
                            </QuestionPressable>;
                        })}
                    </View>
                    {!props.readOnly && <TextInput testID={`async-question-custom-${index}`} multiline
                        accessibilityLabel={`${question.title} — ${t('agentInput.customOptionPlaceholder')}`}
                        placeholder={t('agentInput.customOptionPlaceholder')} placeholderTextColor={theme.colors.textSecondary}
                        value={custom[index]} editable={!disabled} maxLength={20000}
                        onChangeText={value => setCustom(values => values.map((text, i) => i === index ? value : text))}
                        onFocus={() => setFocused(index)} onBlur={() => setFocused(null)}
                        style={[styles.input, focused === index && styles.selected]} />}
                </>}
            </View>)}
            {!status && !props.readOnly && <View style={styles.footer}>
                <QuestionPressable testID="async-question-later" accessibilityRole="button" onPress={() => setCollapsed(true)} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                    <Text style={styles.secondary}>{t('agentInput.asyncQuestion.later')}</Text>
                </QuestionPressable>
                <QuestionPressable testID="async-question-dismiss" accessibilityRole="button" disabled={disabled}
                    onPress={() => void submit('dismiss')} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                    <Text style={styles.secondary}>{t('agentInput.questionSkip')}</Text>
                </QuestionPressable>
                <QuestionPressable testID="async-question-send" accessibilityRole="button"
                    disabled={disabled || answers.some(answer => !answer)} accessibilityState={{ disabled: disabled || answers.some(answer => !answer), busy }}
                    onPress={() => void submit('answer')} style={({ pressed }) => [styles.button, styles.send, pressed && styles.pressed, (disabled || answers.some(answer => !answer)) && styles.disabled]}>
                    {busy ? <ActivityIndicator size="small" color={theme.colors.accent} /> : <Text style={styles.sendText}>{t('agentInput.questionSend')}</Text>}
                </QuestionPressable>
            </View>}
            {!props.readOnly && !props.supported && !status && <Text style={styles.hint}>{t('agentInput.asyncQuestion.unavailable')}</Text>}
            {status === 'uncertain' && <Text style={styles.hint}>{t('agentInput.asyncQuestion.uncertainHint')}</Text>}
            {error && <Text accessibilityRole="alert" style={styles.hint}>{t('agentInput.asyncQuestion.error')}</Text>}
        </>}
    </View>;
});

function QuestionPressable(props: React.ComponentProps<typeof Pressable>) {
    const [hovered, setHovered] = React.useState(false);
    return <Pressable {...props}
        onHoverIn={event => { setHovered(true); props.onHoverIn?.(event); }}
        onHoverOut={event => { setHovered(false); props.onHoverOut?.(event); }}
        style={state => [typeof props.style === 'function' ? props.style(state) : props.style,
            hovered && !props.disabled && styles.pressed]} />;
}

const styles = StyleSheet.create(theme => ({
    card: { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, gap: 12 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    label: { color: theme.colors.textSecondary, fontSize: 12, flex: 1 },
    status: { color: theme.colors.textSecondary, fontSize: 12, flexShrink: 1 },
    hint: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    question: { gap: 10 },
    title: { color: theme.colors.text, fontSize: 14, lineHeight: 21 },
    answer: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 21 },
    option: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, marginBottom: 4 },
    optionText: { color: theme.colors.text, fontSize: 14, lineHeight: 20, flex: 1 },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    input: { color: theme.colors.text, backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10, minHeight: 42, maxHeight: 140, fontSize: 14 },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    button: { minHeight: 36, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
    iconButton: { padding: 6, borderRadius: 6 },
    secondary: { color: theme.colors.textSecondary, fontSize: 13 },
    send: { backgroundColor: theme.colors.surfaceSelected, minWidth: 64 },
    sendText: { color: theme.colors.accent, fontSize: 13, fontWeight: '600' },
    disabled: { opacity: 0.5 },
}));
