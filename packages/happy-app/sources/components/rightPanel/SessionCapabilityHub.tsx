import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Modal } from '@/modal';
import { useSession, useSettingMutable } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { hapticsLight } from '../haptics';
import { useRightSwipePanel } from '../RightSwipePanelHost';
import { CapabilityBlockCard } from './CapabilityBlockCard';
import { CapabilityHubDetailView, SessionActionsDetailView } from './CapabilityHubDetailView';
import { QuickPromptEditorModal } from './QuickPromptEditorModal';
import type { SessionActionItem } from '@/hooks/useSessionQuickActions';
import type { Session } from '@/sync/storageTypes';
import type { CapabilityKey, QuickPromptCapabilityItem } from './sessionCapabilityHubModel';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { SessionFolderBrowserView } from './SessionFolderBrowserView';
import { useFolderRootCount } from './useFolderRootCount';
import { useSessionCapabilityHub } from './useSessionCapabilityHub';
import { usePluginSurfaceViews } from '../plugins/usePluginSurfaceViews';

type CapabilityPanelKey = CapabilityKey | 'sessionActions' | 'folderBrowser';

const BLOCK_ORDER: CapabilityPanelKey[] = ['outputs', 'sources', 'sessionActions', 'skills', 'quickPrompts', 'images', 'folderBrowser', 'files'];

export const SessionCapabilityHub = React.memo(function SessionCapabilityHub(props: {
    sessionId?: string;
    onInsertQuickPrompt?: (prompt: string) => void;
}) {
    if (!props.sessionId) {
        return <CapabilityHubPlaceholder />;
    }
    return <SessionCapabilityHubInner onInsertQuickPrompt={props.onInsertQuickPrompt} sessionId={props.sessionId} />;
});

const SessionCapabilityHubInner = React.memo(function SessionCapabilityHubInner(props: {
    sessionId: string;
    onInsertQuickPrompt?: (prompt: string) => void;
}) {
    const session = useSession(props.sessionId);

    if (!session) {
        return <CapabilityHubPlaceholder />;
    }

    return (
        <SessionCapabilityHubLoaded
            onInsertQuickPrompt={props.onInsertQuickPrompt}
            session={session}
            sessionId={props.sessionId}
        />
    );
});

const SessionCapabilityHubLoaded = React.memo(function SessionCapabilityHubLoaded(props: {
    session: Session;
    sessionId: string;
    onInsertQuickPrompt?: (prompt: string) => void;
}) {
    const { theme } = useUnistyles();
    const model = useSessionCapabilityHub(props.sessionId);
    const pluginViews = usePluginSurfaceViews('right-panel');
    const generatedImagesViewAvailable = pluginViews.some((view) => (
        view.componentId === 'generated-images-session-images'
    ));
    // 取会话工作目录与家目录，用于文件夹浏览卡片
    const rootPath = props.session.metadata?.path ?? null;
    const homeDir = props.session.metadata?.homeDir ?? null;
    const folderCount = useFolderRootCount(props.sessionId, rootPath);
    const panel = useRightSwipePanel();
    const [quickPrompts, setQuickPrompts] = useSettingMutable('quickPrompts');
    const [selectedKey, setSelectedKey] = React.useState<CapabilityPanelKey | null>(null);
    const { onInsertQuickPrompt, sessionId } = props;
    const { actionItems } = useSessionQuickActions(props.session, {
        onAfterArchive: () => panel?.closePanel(),
        onAfterDelete: () => panel?.closePanel(),
    });

    React.useEffect(() => {
        setSelectedKey(null);
    }, [props.sessionId]);

    React.useEffect(() => {
        if (panel?.isOpen === false) setSelectedKey(null);
    }, [panel?.isOpen]);

    React.useEffect(() => {
        if (selectedKey === 'images' && !generatedImagesViewAvailable) setSelectedKey(null);
    }, [generatedImagesViewAvailable, selectedKey]);

    const returnToSummary = React.useCallback(() => {
        setSelectedKey(null);
        // The detail trigger unmounts during this state change. Restore focus
        // to the still-open dialog after React commits the summary view.
        panel?.focusPanel?.();
    }, [panel]);

    React.useEffect(() => {
        if (!selectedKey) return;
        return panel?.registerBackHandler(() => {
            returnToSummary();
            return true;
        });
    }, [panel, returnToSummary, selectedKey]);

    const addQuickPrompt = React.useCallback(() => {
        Modal.show({
            component: QuickPromptEditorModal,
            props: {
                onSave: ({ title, prompt }: { title: string; prompt: string }) => {
                    const now = Date.now();
                    setQuickPrompts([
                        {
                            id: `quick-prompt-${now}`,
                            title,
                            prompt,
                            createdAt: now,
                            updatedAt: now,
                        },
                        ...quickPrompts,
                    ]);
                    setSelectedKey('quickPrompts');
                },
            },
        });
    }, [quickPrompts, setQuickPrompts]);

    const deleteQuickPrompt = React.useCallback(async (item: QuickPromptCapabilityItem) => {
        const confirmed = await Modal.confirm(
            t('rightPanelCapabilityHub.quickPrompt.deleteTitle'),
            t('rightPanelCapabilityHub.quickPrompt.deleteMessage', { title: item.title }),
            {
                confirmText: t('common.delete'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        setQuickPrompts(quickPrompts.filter((entry) => entry.id !== item.id));
    }, [quickPrompts, setQuickPrompts]);

    const runQuickPrompt = React.useCallback((item: QuickPromptCapabilityItem) => {
        hapticsLight();
        sync.sendMessage(sessionId, item.prompt, { source: 'chat' });
        panel?.closePanel();
    }, [panel, sessionId]);

    const insertQuickPrompt = React.useCallback((item: QuickPromptCapabilityItem) => {
        if (!onInsertQuickPrompt) return;
        hapticsLight();
        onInsertQuickPrompt(item.prompt);
        panel?.closePanel();
    }, [onInsertQuickPrompt, panel]);

    const runSessionAction = React.useCallback((item: SessionActionItem) => {
        hapticsLight();
        panel?.closePanel();
        item.onPress();
    }, [panel]);

    if (selectedKey) {
        if (selectedKey === 'sessionActions') {
            return (
                <SessionActionsDetailView
                    actions={actionItems}
                    onActionPress={runSessionAction}
                    onBack={returnToSummary}
                    title={t('rightPanelCapabilityHub.blocks.sessionActions')}
                />
            );
        }

        // 文件夹浏览详情视图：分支必须在通用 return 之前，使 selectedKey narrow 为 CapabilityKey
        if (selectedKey === 'folderBrowser') {
            if (!rootPath || !homeDir) {
                return null;
            }
            return (
                <SessionFolderBrowserView
                    homeDir={homeDir}
                    onExit={returnToSummary}
                    rootPath={rootPath}
                    sessionId={sessionId}
                />
            );
        }

        return (
            <CapabilityHubDetailView
                count={model.details[selectedKey].length}
                items={model.details[selectedKey]}
                onAddQuickPrompt={selectedKey === 'quickPrompts' ? addQuickPrompt : undefined}
                onBack={returnToSummary}
                onDeleteQuickPrompt={deleteQuickPrompt}
                onInsertQuickPrompt={insertQuickPrompt}
                onRunQuickPrompt={runQuickPrompt}
                sessionId={sessionId}
                title={t(`rightPanelCapabilityHub.blocks.${selectedKey}` as const)}
                type={selectedKey}
            />
        );
    }

    return (
        <ScrollView
            contentContainerStyle={styles.summaryContent}
            showsVerticalScrollIndicator={false}
        >
            <View style={styles.heading}>
                <Text numberOfLines={1} style={[styles.headingTitle, { color: theme.colors.text }]}>
                    {t('rightPanelCapabilityHub.title')}
                </Text>
            </View>

            <View style={styles.grid}>
                {BLOCK_ORDER.map((key) => {
                    if (key === 'images' && !generatedImagesViewAvailable) return null;
                    if (key === 'sessionActions') {
                        return (
                            <CapabilityBlockCard
                                count={actionItems.length}
                                icon={<Ionicons color={theme.colors.text} name="ellipsis-horizontal-circle-outline" size={17} />}
                                key={key}
                                onPress={() => setSelectedKey(key)}
                                preview={getSessionActionsPreview(actionItems)}
                                title={t('rightPanelCapabilityHub.blocks.sessionActions')}
                            />
                        );
                    }

                    // 文件夹浏览卡：不在 model.blocks 中，单独渲染，必须在 find 之前
                    if (key === 'folderBrowser') {
                        return (
                            <CapabilityBlockCard
                                count={folderCount ?? 0}
                                disabled={!rootPath}
                                icon={<Ionicons color={rootPath ? theme.colors.text : theme.colors.textSecondary} name="folder-outline" size={16} />}
                                key={key}
                                onPress={rootPath ? () => setSelectedKey(key) : undefined}
                                preview={rootPath ? formatPathRelativeToHome(rootPath, homeDir ?? undefined) : null}
                                title={t('rightPanelCapabilityHub.blocks.folderBrowser')}
                            />
                        );
                    }

                    const block = model.blocks.find((entry) => entry.key === key);
                    if (!block) return null;
                    return (
                        <CapabilityBlockCard
                            count={block.count}
                            icon={renderBlockIcon(key, theme.colors.text)}
                            key={key}
                            onPress={() => setSelectedKey(key)}
                            preview={block.preview ?? getTaskContextEmptyPreview(key)}
                            testID={`capability-block-${key}`}
                            title={t(`rightPanelCapabilityHub.blocks.${key}` as const)}
                        />
                    );
                })}
            </View>
        </ScrollView>
    );
});

function getSessionActionsPreview(actionItems: SessionActionItem[]): string | null {
    const priority = actionItems.filter((item) => item.destructive);
    const source = priority.length > 0 ? priority : actionItems;
    const labels = source.slice(0, 2).map((item) => item.label);
    return labels.length > 0 ? labels.join(' · ') : null;
}

function getTaskContextEmptyPreview(key: CapabilityKey): string | null {
    if (key === 'outputs' || key === 'sources') {
        return t(`rightPanelCapabilityHub.empty.${key}` as const);
    }
    return null;
}

const CapabilityHubPlaceholder = React.memo(function CapabilityHubPlaceholder() {
    const { theme } = useUnistyles();
    const pluginViews = usePluginSurfaceViews('right-panel');
    const generatedImagesViewAvailable = pluginViews.some((view) => (
        view.componentId === 'generated-images-session-images'
    ));

    return (
        <ScrollView
            contentContainerStyle={styles.summaryContent}
            showsVerticalScrollIndicator={false}
        >
            <View style={styles.heading}>
                <Text numberOfLines={1} style={[styles.headingTitle, { color: theme.colors.text }]}>
                    {t('rightPanelCapabilityHub.title')}
                </Text>
                <Text style={[styles.placeholderCopy, { color: theme.colors.textSecondary }]}>
                    {t('rightPanelCapabilityHub.emptyHomeDescription')}
                </Text>
            </View>

            <View style={styles.grid}>
                {BLOCK_ORDER.filter((key) => key !== 'images' || generatedImagesViewAvailable).map((key) => (
                    <CapabilityBlockCard
                        count={0}
                        disabled={true}
                        icon={renderPanelIcon(key, theme.colors.textSecondary)}
                        key={key}
                        preview={null}
                        title={t(`rightPanelCapabilityHub.blocks.${key}` as const)}
                    />
                ))}
            </View>
        </ScrollView>
    );
});

function renderBlockIcon(key: CapabilityKey, color: string) {
    switch (key) {
        case 'outputs':
            return <Ionicons color={color} name="sparkles-outline" size={16} />;
        case 'sources':
            return <Ionicons color={color} name="link-outline" size={16} />;
        case 'skills':
            return <Ionicons color={color} name="flash-outline" size={16} />;
        case 'quickPrompts':
            return <Ionicons color={color} name="chatbubble-ellipses-outline" size={16} />;
        case 'images':
            return <Ionicons color={color} name="image-outline" size={16} />;
        case 'artifacts':
            return <Ionicons color={color} name="document-text-outline" size={16} />;
        case 'files':
            return <Octicons color={color} name="file-code" size={15} />;
    }
}

// 统一图标函数：兼容 sessionActions / folderBrowser 等非 CapabilityKey 的面板 key
function renderPanelIcon(key: CapabilityPanelKey, color: string) {
    if (key === 'sessionActions') {
        return <Ionicons color={color} name="ellipsis-horizontal-circle-outline" size={17} />;
    }
    if (key === 'folderBrowser') {
        return <Ionicons color={color} name="folder-outline" size={16} />;
    }
    return renderBlockIcon(key, color);
}

const styles = StyleSheet.create(() => ({
    summaryContent: {
        paddingBottom: 24,
        paddingHorizontal: 12,
        paddingTop: 10,
    },
    heading: {
        marginBottom: 12,
        paddingHorizontal: 2,
    },
    headingTitle: {
        fontSize: 19,
        fontWeight: '700',
        letterSpacing: -0.4,
    },
    placeholderCopy: {
        fontSize: 13,
        lineHeight: 18,
        marginTop: 6,
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        rowGap: 10,
    },
}));
