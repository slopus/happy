import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalTask } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';

export function ProjectConversationEmptyState({ task, onDraft, onFiles, onStart, startLabel, disabled, scrollable = true }: {
    task: Pick<GoalTask, 'title' | 'goal'>; onDraft?: (value: string) => void; onFiles: () => void; onStart?: () => void; startLabel?: string; disabled?: boolean; scrollable?: boolean;
}) {
    const { theme } = useUnistyles();
    const content = <View style={styles.content}>
            <View style={styles.eyebrow}><View style={styles.icon}><Ionicons name="chatbubbles-outline" size={23} color={theme.colors.textLink} /></View><Text style={styles.label}>{t('projectGoals.emptyConversationEyebrow')}</Text></View>
            <Text style={styles.kicker}>{t('projectGoals.emptyConversationTitle')}</Text>
            <Text accessibilityRole="header" style={styles.title}>{task.title}</Text>
            <Text style={styles.hint}>{t('projectGoals.emptyConversationHint')}</Text>
            {!!task.goal && task.goal !== task.title && <View style={styles.goal}><View style={styles.goalRule} /><Text numberOfLines={3} style={styles.goalText}>{task.goal}</Text></View>}
            <View style={styles.actions}>
                {onDraft && <><Button variant="row" label={t('projectGoals.discussNextStep')} onPress={() => onDraft(t('projectGoals.nextStepDraft', { title: task.title }))} testID="project-empty-next-step"><Ionicons name="compass-outline" size={18} color={theme.colors.textLink} /><Text style={styles.actionLabel}>{t('projectGoals.discussNextStep')}</Text><Ionicons name="arrow-up-outline" size={14} color={theme.colors.textSecondary} /></Button>
                <Button variant="row" label={t('projectGoals.discussDelivery')} onPress={() => onDraft(t('projectGoals.deliveryDraft', { title: task.title }))} testID="project-empty-delivery"><Ionicons name="checkmark-done-outline" size={18} color={theme.colors.textLink} /><Text style={styles.actionLabel}>{t('projectGoals.discussDelivery')}</Text><Ionicons name="arrow-up-outline" size={14} color={theme.colors.textSecondary} /></Button></>}
                {onStart && <Button variant="primary" disabled={disabled} label={startLabel || t('projectGoals.openChat')} onPress={onStart} testID="project-empty-start"><Ionicons name="chatbubble-outline" size={18} color={theme.colors.textLink} /><Text style={styles.actionLabel}>{startLabel || t('projectGoals.openChat')}</Text><Ionicons name="arrow-forward" size={14} color={theme.colors.textSecondary} /></Button>}
                <Button variant="toolbar" label={t('projectGoals.viewTaskFiles')} onPress={onFiles} testID="project-empty-files"><Ionicons name="folder-open-outline" size={16} color={theme.colors.textSecondary} /><Text style={styles.secondary}>{t('projectGoals.viewTaskFiles')}</Text><Ionicons name="arrow-forward" size={14} color={theme.colors.textSecondary} /></Button>
            </View>
            {onDraft && <Text style={styles.note}>{t('projectGoals.draftOnlyHint')}</Text>}
        </View>;
    return scrollable ? <ScrollView testID="project-conversation-empty" style={styles.container} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>{content}</ScrollView>
        : <View testID="project-conversation-empty" style={styles.staticContainer}>{content}</View>;
}

const styles = StyleSheet.create(theme => ({
    container: { width: '100%', alignSelf: 'stretch' },
    staticContainer: { width: '100%', flexShrink: 0, paddingHorizontal: 28, paddingVertical: 18 },
    scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 30 },
    content: { width: '100%', maxWidth: 420, alignSelf: 'center', gap: 13 },
    eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 7 },
    icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: theme.colors.surfaceSelected, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    label: { fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    kicker: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    title: { fontSize: 25, lineHeight: 35, color: theme.colors.text, ...Typography.default('semiBold') },
    hint: { fontSize: 13, lineHeight: 22, color: theme.colors.textSecondary, ...Typography.default() },
    goal: { flexDirection: 'row', gap: 11, marginTop: 3 },
    goalRule: { width: 2, borderRadius: 2, backgroundColor: theme.colors.divider },
    goalText: { flex: 1, color: theme.colors.textSecondary, fontSize: 12, lineHeight: 20, ...Typography.default() },
    actions: { gap: 8, marginTop: 13 },
    actionLabel: { flex: 1, color: theme.colors.text, fontSize: 13, lineHeight: 20, ...Typography.default('semiBold') },
    secondary: { color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    note: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 18, ...Typography.default() },
}));
