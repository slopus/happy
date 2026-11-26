import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { WorkspaceButton } from '@/components/fileWorkspace/WorkspaceButton';
import { useUnistyles } from 'react-native-unistyles';
import { PanelTabs } from '@/components/PanelTabs';
import { t, getCurrentLanguage } from '@/text';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { ProjectConversationNavigationPane, useProjectConversationNavigation } from './ProjectConversationNavigation.web';
import { MotionArtifactPanel } from '@/components/motionWorkbench/MotionArtifactPanel';

/** Scope and Task share the same right-column frame and file-tab semantics. */
export function ProjectDetailsPanel({
    header,
    tab,
    onTab,
    children,
    footer,
    testID,
    style,
    showTabs = true,
}: {
    header: React.ReactNode;
    tab: string;
    onTab: (value: string) => void;
    children: React.ReactNode;
    footer: React.ReactNode;
    testID: string;
    style?: any;
    showTabs?: boolean;
}) {
    const { theme } = useUnistyles();
    const conversations = useProjectConversationNavigation();
    const workspace = useFileWorkspace();
    const [showConversations, setShowConversations] = React.useState(true);
    const activeTab = showTabs && conversations && showConversations && tab !== 'files' ? 'sessions' : tab;
    const selectTab = (value: string) => {
        if (value === 'sessions') workspace?.setMaximized(false);
        setShowConversations(value === 'sessions');
        onTab(value === 'sessions' ? 'details' : value);
    };
    return (
        <View style={[styles.panel, style]} testID={testID}>
            <View style={styles.header}>{header}</View>
            {showTabs && (
                <View style={styles.tabs}>
                    <PanelTabs
                        activeTab={activeTab}
                        onTabChange={selectTab}
                        testIDPrefix={testID === 'project-task-panel' ? 'project-task' : 'project-scope'}
                        tabs={[
                            ...(conversations
                                ? [
                                      {
                                          key: 'sessions',
                                          label: getCurrentLanguage().startsWith('zh') ? '会话' : 'Sessions',
                                          icon: 'chatbubbles-outline' as const,
                                      },
                                  ]
                                : []),
                            { key: 'details', label: t('projectGoals.details'), icon: 'document-text-outline' },
                            { key: 'artifacts', label: getCurrentLanguage().startsWith('zh') ? '产物' : 'Artifacts', icon: 'albums-outline' },
                            { key: 'files', label: t('projectGoals.files'), icon: 'folder-outline' },
                        ]}
                    />
                </View>
            )}
            {activeTab === 'sessions' ? (
                <ProjectConversationNavigationPane onReveal={() => selectTab('sessions')}>
                    {conversations}
                </ProjectConversationNavigationPane>
            ) : activeTab === 'artifacts' ? (
                <View style={{ padding: 12, gap: 10 }}>{workspace?.sessionId && !workspace.readOnly ? <MotionArtifactPanel sessionId={workspace.sessionId} mode="library" /> : <><Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{getCurrentLanguage().startsWith('zh') ? '先从项目会话列表选择一个在线执行会话，再查看此目录的产物。打开工程不会自动向 AI 发送要求。' : 'Select a connected project conversation to access this workspace. Opening a project does not send an AI request.'}</Text><WorkspaceButton label={getCurrentLanguage().startsWith('zh') ? '选择项目会话' : 'Choose project conversation'} icon="chatbubbles-outline" onPress={() => selectTab('sessions')} /></>}</View>
            ) : (
                children
            )}
            {activeTab !== 'sessions' && <View style={styles.footer}>{footer}</View>}
        </View>
    );
}
const styles = StyleSheet.create((theme) => ({
    panel: { minHeight: 0, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, overflow: 'hidden' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 48,
        padding: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    tabs: {
        flexDirection: 'row',
        minHeight: 48,
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    footer: {
        padding: 12,
        gap: 8,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
}));
