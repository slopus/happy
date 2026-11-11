import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PanelTabs } from '@/components/PanelTabs';
import { t } from '@/text';

/** Scope and Task share the same right-column frame and file-tab semantics. */
export function ProjectDetailsPanel({ header, tab, onTab, children, footer, testID, style, showTabs = true }: {
    header: React.ReactNode; tab: string; onTab: (value: string) => void;
    children: React.ReactNode; footer: React.ReactNode; testID: string; style?: any; showTabs?: boolean;
}) {
    return <View style={[styles.panel, style]} testID={testID}>
        <View style={styles.header}>{header}</View>
        {showTabs && <View style={styles.tabs}><PanelTabs activeTab={tab} onTabChange={onTab} testIDPrefix={testID === 'project-task-panel' ? 'project-task' : 'project-scope'} tabs={[
            { key: 'details', label: t('projectGoals.details'), icon: 'document-text-outline' },
            { key: 'files', label: t('projectGoals.files'), icon: 'folder-outline' },
        ]} /></View>}
        {children}
        <View style={styles.footer}>{footer}</View>
    </View>;
}
const styles = StyleSheet.create(theme => ({
    panel: { minHeight: 0, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, overflow: 'hidden' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, padding: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    tabs: { flexDirection: 'row', minHeight: 48, paddingHorizontal: 12, paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    footer: { padding: 12, gap: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
}));
