import * as React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalTask } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { ProjectSurfaces } from './ProjectSurfaces';

/** The task brief stays readable even when an older archive has no delivery contract. */
export function ProjectTaskDetails({ task, number, approval, onEdit, editDisabled, children }: {
    task: GoalTask; number: number; approval: React.ReactNode; onEdit: () => void; editDisabled: boolean; children: React.ReactNode;
}) {
    const surfaces = React.useContext(ProjectSurfaces);
    const { theme } = useUnistyles();
    const [criteriaOpen, setCriteriaOpen] = React.useState(false);
    const criteria = task.acceptanceCriteria ?? [];
    const outputs = task.artifacts.filter(artifact => artifact.relation === 'output');
    return <View style={styles.content} testID="project-task-brief">
        <View style={styles.identity}><Text style={styles.number}>{task.code || `TASK ${String(number).padStart(2, '0')}`}</Text>{approval}</View>
        <Text accessibilityRole="header" selectable style={styles.title}>{task.title}</Text>
        <View style={styles.section}>
            <View style={styles.heading}><Text style={styles.label}>{t('projectGoals.goal')}</Text><Button variant="toolbar" label={t('projectGoals.editWithAI')} disabled={editDisabled} onPress={onEdit}><Ionicons name="sparkles-outline" size={12} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.editWithAI')}</Text></Button></View>
            <Text selectable style={styles.goal}>{task.goal || task.title}</Text>
        </View>
        <View style={styles.section}>
            <Text style={styles.label}>{t('projectGoals.deliveryHeading')}</Text>
            <View style={[styles.agreement, surfaces && { backgroundColor: surfaces.selected }]} testID="project-task-delivery-agreement">
                <Text style={styles.agreementLabel}>{t('projectGoals.expected')}</Text>
                {task.expectedDeliverables.length ? task.expectedDeliverables.map((value, index) => <View key={index} style={styles.item}><Text style={styles.bullet}>•</Text><Text selectable style={styles.body}>{value}</Text></View>) : <Text style={styles.secondary}>{t('projectGoals.noExpected')}</Text>}
            </View>
        </View>
        <View style={styles.section}>
            <View style={styles.heading}><Text style={styles.label}>{t('projectGoals.finals')}</Text>{outputs.length > 0 && <Text style={styles.number}>{outputs.length}</Text>}</View>
            <Text style={styles.secondary}>{t('projectGoals.confirmationHint')}</Text>
            {outputs.length ? children : <View style={styles.noDelivery} testID="project-task-no-delivery"><Ionicons name="document-text-outline" size={22} color={theme.colors.textSecondary} /><Text style={styles.emptyTitle}>{t('projectGoals.noFinals')}</Text><Text style={styles.secondary}>{t('projectGoals.noFinalsHint')}</Text></View>}
        </View>
        {criteria.length > 0 && <View style={styles.criteria}>
            <Button variant="toolbar" label={t('projectGoals.criteria')} expanded={criteriaOpen} onPress={() => setCriteriaOpen(value => !value)} testID="project-task-criteria-toggle"><Ionicons name={criteriaOpen ? 'chevron-down' : 'chevron-forward'} size={12} color={theme.colors.textSecondary} /><Text style={styles.secondary}>{t('projectGoals.criteria')} · {criteria.length}</Text></Button>
            {criteriaOpen && <View style={styles.criteriaItems} testID="project-task-criteria-content">{criteria.map((value, index) => <View key={index} style={styles.item}><Text style={styles.secondary}>{index + 1}.</Text><Text selectable style={styles.body}>{value}</Text></View>)}</View>}
        </View>}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    content: { padding: 20, gap: 22 },
    identity: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: -12 },
    number: { fontSize: 10, letterSpacing: 0.8, color: theme.colors.textSecondary, ...Typography.default() },
    title: { fontSize: 21, lineHeight: 30, color: theme.colors.text, ...Typography.default('semiBold') },
    section: { gap: 12 },
    heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    label: { fontSize: 12, lineHeight: 18, color: theme.colors.text, ...Typography.default('semiBold') },
    goal: { fontSize: 13, lineHeight: 24, color: theme.colors.textSecondary, ...Typography.default() },
    link: { fontSize: 11, color: theme.colors.textLink, ...Typography.default() },
    agreement: { padding: 14, gap: 8, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceSelected },
    agreementLabel: { fontSize: 10, lineHeight: 16, color: theme.colors.textLink, ...Typography.default() },
    item: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    bullet: { fontSize: 13, lineHeight: 22, color: theme.colors.textLink },
    body: { flex: 1, fontSize: 12, lineHeight: 22, color: theme.colors.text, ...Typography.default() },
    secondary: { fontSize: 11, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
    noDelivery: { borderRadius: 9, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.divider, padding: 16, gap: 7 },
    emptyTitle: { fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    criteria: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, paddingTop: 10, alignItems: 'flex-start' },
    criteriaItems: { gap: 10, paddingTop: 8, paddingHorizontal: 10, alignSelf: 'stretch' },
}));
