import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import type { SessionActionItem } from '@/hooks/useSessionQuickActions';
import { imageViewer } from '@/sync/imageViewer';
import { getCurrentLanguage, t } from '@/text';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { thumbhashToDataUri } from '@/utils/thumbhash';
import type {
    ArtifactCapabilityItem,
    CapabilityItem,
    CapabilityKey,
    FileCapabilityItem,
    ImageCapabilityItem,
    QuickPromptCapabilityItem,
    TaskResourceCapabilityItem,
} from './sessionCapabilityHubModel';

type Props = {
    count: number;
    items: CapabilityItem[];
    onAddQuickPrompt?: () => void;
    onBack: () => void;
    onDeleteQuickPrompt?: (item: QuickPromptCapabilityItem) => void;
    onInsertQuickPrompt?: (item: QuickPromptCapabilityItem) => void;
    onRunQuickPrompt?: (item: QuickPromptCapabilityItem) => void;
    sessionId: string;
    title: string;
    type: CapabilityKey;
};

export const CapabilityHubDetailView = React.memo(function CapabilityHubDetailView(props: Props) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            <View style={[styles.header, { borderBottomColor: theme.colors.divider }]}>
                <Pressable hitSlop={8} onPress={props.onBack} style={styles.backButton}>
                    <Ionicons color={theme.colors.text} name="chevron-back" size={18} />
                    <Text style={[styles.backText, { color: theme.colors.text }]}>{t('rightPanelCapabilityHub.back')}</Text>
                </Pressable>
                <View style={styles.headerCopy}>
                    <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.colors.text }]}>
                        {props.title}
                    </Text>
                    <Text style={[styles.headerMeta, { color: theme.colors.textSecondary }]}>
                        {props.count}
                    </Text>
                </View>
                {props.type === 'quickPrompts' && props.onAddQuickPrompt ? (
                    <Pressable hitSlop={8} onPress={props.onAddQuickPrompt} style={[styles.addButton, { backgroundColor: theme.colors.surfaceHigh }]}>
                        <Ionicons color={theme.colors.text} name="add" size={18} />
                    </Pressable>
                ) : null}
            </View>

            {props.items.length === 0 ? (
                <View style={styles.emptyWrap}>
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        {t(`rightPanelCapabilityHub.empty.${props.type}` as const)}
                    </Text>
                    {props.type === 'quickPrompts' && props.onAddQuickPrompt ? (
                        <Pressable
                            onPress={props.onAddQuickPrompt}
                            style={({ pressed }) => [
                                styles.emptyAction,
                                {
                                    backgroundColor: theme.colors.button.primary.background,
                                    opacity: pressed ? 0.82 : 1,
                                },
                            ]}
                        >
                            <Text style={[styles.emptyActionText, { color: theme.colors.button.primary.tint }]}>
                                {t('rightPanelCapabilityHub.quickPrompt.add')}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : (
                <ScrollView
                    contentContainerStyle={styles.scrollContent}
                    showsVerticalScrollIndicator={false}
                >
                    {props.items.map((item) => (
                        <CapabilityItemRow
                            item={item}
                            key={item.id}
                            onDeleteQuickPrompt={props.onDeleteQuickPrompt}
                            onInsertQuickPrompt={props.onInsertQuickPrompt}
                            onRunQuickPrompt={props.onRunQuickPrompt}
                            sessionId={props.sessionId}
                        />
                    ))}
                </ScrollView>
            )}
        </View>
    );
});

export const SessionActionsDetailView = React.memo(function SessionActionsDetailView(props: {
    actions: SessionActionItem[];
    onActionPress: (item: SessionActionItem) => void;
    onBack: () => void;
    title: string;
}) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            <View style={[styles.header, { borderBottomColor: theme.colors.divider }]}>
                <Pressable hitSlop={8} onPress={props.onBack} style={styles.backButton}>
                    <Ionicons color={theme.colors.text} name="chevron-back" size={18} />
                    <Text style={[styles.backText, { color: theme.colors.text }]}>{t('rightPanelCapabilityHub.back')}</Text>
                </Pressable>
                <View style={styles.headerCopy}>
                    <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.colors.text }]}>
                        {props.title}
                    </Text>
                    <Text style={[styles.headerMeta, { color: theme.colors.textSecondary }]}>
                        {props.actions.length}
                    </Text>
                </View>
            </View>

            {props.actions.length === 0 ? (
                <View style={styles.emptyWrap}>
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        {t('rightPanelCapabilityHub.empty.sessionActions')}
                    </Text>
                </View>
            ) : (
                <ScrollView
                    contentContainerStyle={styles.scrollContent}
                    showsVerticalScrollIndicator={false}
                >
                    {props.actions.map((action) => (
                        <SessionActionItemRow
                            action={action}
                            key={action.id}
                            onPress={props.onActionPress}
                        />
                    ))}
                </ScrollView>
            )}
        </View>
    );
});

const SessionActionItemRow = React.memo(function SessionActionItemRow(props: {
    action: SessionActionItem;
    onPress: (item: SessionActionItem) => void;
}) {
    const { theme } = useUnistyles();
    const color = props.action.destructive ? theme.colors.status.error : theme.colors.text;

    return (
        <Pressable
            onPress={() => props.onPress(props.action)}
            style={({ pressed }) => [
                styles.rowCard,
                {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                    transform: [{ scale: pressed ? 0.99 : 1 }],
                },
            ]}
        >
            <View style={[styles.rowIconWrap, { backgroundColor: theme.colors.surfaceHigh }]}>
                <Ionicons color={color} name={props.action.icon as keyof typeof Ionicons.glyphMap} size={16} />
            </View>
            <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color }]}>
                    {props.action.label}
                </Text>
            </View>
            <Ionicons color={color} name="chevron-forward" size={16} />
        </Pressable>
    );
});

const CapabilityItemRow = React.memo(function CapabilityItemRow(props: {
    item: CapabilityItem;
    onDeleteQuickPrompt?: (item: QuickPromptCapabilityItem) => void;
    onInsertQuickPrompt?: (item: QuickPromptCapabilityItem) => void;
    onRunQuickPrompt?: (item: QuickPromptCapabilityItem) => void;
    sessionId: string;
}) {
    if (props.item.kind === 'quickPrompt') {
        return (
            <QuickPromptItemRow
                item={props.item}
                onDelete={props.onDeleteQuickPrompt}
                onInsert={props.onInsertQuickPrompt}
                onRun={props.onRunQuickPrompt}
            />
        );
    }
    if (props.item.kind === 'taskResource') {
        return <TaskResourceItemRow item={props.item} sessionId={props.sessionId} />;
    }
    if (props.item.kind === 'image') {
        return <ImageItemRow item={props.item} sessionId={props.sessionId} />;
    }
    if (props.item.kind === 'artifact') {
        return <ArtifactItemRow item={props.item} />;
    }
    if (props.item.kind === 'file') {
        return <FileItemRow item={props.item} sessionId={props.sessionId} />;
    }
    return <SkillItemRow title={props.item.title} />;
});

const TaskResourceItemRow = React.memo(function TaskResourceItemRow(props: {
    item: TaskResourceCapabilityItem;
    sessionId: string;
}) {
    if (props.item.event.resourceType === 'image') {
        return <TaskResourceImageItemRow item={props.item} sessionId={props.sessionId} />;
    }
    return <TaskResourceTextItemRow item={props.item} sessionId={props.sessionId} />;
});

const TaskResourceTextItemRow = React.memo(function TaskResourceTextItemRow(props: {
    item: TaskResourceCapabilityItem;
    sessionId: string;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const event = props.item.event;
    const onPress = event.resourceType === 'file'
        ? () => router.push(`/session/${props.sessionId}/file?path=${btoa(event.path)}` as any)
        : event.resourceType === 'artifact' && event.artifactId
            ? () => router.push(`/artifacts/${event.artifactId}` as any)
            : event.resourceType === 'web'
                ? () => { void openExternalUrl(event.uri); }
                : event.resourceType === 'attachment'
                    ? () => router.push(`/session/${props.sessionId}/message/${event.messageId}` as any)
                    : undefined;

    return (
        <Pressable
            accessibilityRole={onPress ? 'button' : undefined}
            disabled={!onPress}
            onPress={onPress}
            testID={`task-context-${event.kind === 'source_used' ? 'source' : 'output'}-${event.resourceType}`}
            style={({ pressed }) => [
                styles.rowCard,
                {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                    opacity: onPress ? 1 : 0.78,
                    transform: [{ scale: pressed ? 0.99 : 1 }],
                },
            ]}
        >
            <View style={[styles.rowIconWrap, { backgroundColor: theme.colors.surfaceHigh }]}>
                {renderTaskResourceIcon(event.resourceType, theme.colors.text)}
            </View>
            <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text }]}>
                    {event.title}
                </Text>
                <Text numberOfLines={1} style={[styles.rowMeta, { color: theme.colors.textSecondary }]}>
                    {getTaskResourceLocator(event)}
                </Text>
                <Text numberOfLines={1} style={[styles.resourceStatus, { color: theme.colors.textSecondary }]}>
                    {getTaskResourceStatus(event)} · {formatResourceTimestamp(event.createdAt)}{event.occurrences > 1 ? ` · ×${event.occurrences}` : ''}
                </Text>
            </View>
            {onPress ? <Ionicons color={theme.colors.textSecondary} name={event.resourceType === 'web' ? 'open-outline' : 'chevron-forward'} size={16} /> : null}
        </Pressable>
    );
});

const TaskResourceImageItemRow = React.memo(function TaskResourceImageItemRow(props: {
    item: TaskResourceCapabilityItem;
    sessionId: string;
}) {
    const { theme } = useUnistyles();
    const event = props.item.event;
    const ref = event.resourceType === 'image' ? event.uri : undefined;
    const { uri } = useAttachmentImage(props.sessionId, ref);
    const placeholder = React.useMemo(() => {
        if (!event.thumbhash) return undefined;
        const placeholderUri = thumbhashToDataUri(event.thumbhash);
        return placeholderUri ? { uri: placeholderUri } : undefined;
    }, [event.thumbhash]);

    return (
        <Pressable
            accessibilityRole="button"
            disabled={!uri}
            onPress={uri ? () => imageViewer.open({
                uri,
                width: event.width,
                height: event.height,
                filename: event.title,
            }) : undefined}
            testID={`task-context-${event.kind === 'source_used' ? 'source' : 'output'}-image`}
            style={({ pressed }) => [
                styles.rowCard,
                styles.imageRowCard,
                {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                    opacity: uri ? 1 : 0.78,
                    transform: [{ scale: pressed ? 0.99 : 1 }],
                },
            ]}
        >
            <View style={[styles.imageThumbWrap, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                <Image
                    contentFit="cover"
                    placeholder={placeholder}
                    source={uri ? { uri } : undefined}
                    style={styles.imageThumb}
                    transition={150}
                />
                {!uri ? (
                    <View style={styles.imageThumbOverlay}>
                        <Ionicons color={theme.colors.textSecondary} name="image-outline" size={20} />
                    </View>
                ) : null}
            </View>
            <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text }]}>{event.title}</Text>
                <Text numberOfLines={1} style={[styles.rowMeta, { color: theme.colors.textSecondary }]}>
                    {event.localPath ?? t('rightPanelCapabilityHub.meta.image')}
                </Text>
                <Text numberOfLines={1} style={[styles.resourceStatus, { color: theme.colors.textSecondary }]}>
                    {getTaskResourceStatus(event)} · {formatResourceTimestamp(event.createdAt)}{event.occurrences > 1 ? ` · ×${event.occurrences}` : ''}
                </Text>
            </View>
            {uri ? <Ionicons color={theme.colors.textSecondary} name="expand-outline" size={16} /> : null}
        </Pressable>
    );
});

function renderTaskResourceIcon(resourceType: TaskResourceCapabilityItem['event']['resourceType'], color: string) {
    switch (resourceType) {
        case 'file':
            return <Octicons color={color} name="file-code" size={14} />;
        case 'web':
            return <Ionicons color={color} name="globe-outline" size={16} />;
        case 'artifact':
            return <Ionicons color={color} name="document-text-outline" size={15} />;
        case 'attachment':
            return <Ionicons color={color} name="attach-outline" size={16} />;
        case 'image':
            return <Ionicons color={color} name="image-outline" size={16} />;
    }
}

function getTaskResourceLocator(event: TaskResourceCapabilityItem['event']): string {
    if (event.resourceType === 'file') return event.path;
    if (event.resourceType === 'web') {
        try {
            const hostname = new URL(event.uri).hostname;
            return event.title === hostname ? event.uri : hostname;
        } catch {
            return event.uri;
        }
    }
    if (event.resourceType === 'artifact') return t('rightPanelCapabilityHub.meta.artifact');
    return event.localPath ?? event.title;
}

function getTaskResourceStatus(event: TaskResourceCapabilityItem['event']): string {
    switch (event.kind) {
        case 'file_created':
            return t('rightPanelCapabilityHub.meta.created');
        case 'file_modified':
            return t('rightPanelCapabilityHub.meta.updated');
        case 'preview_created':
            return t('rightPanelCapabilityHub.meta.preview');
        case 'source_used':
            return t('rightPanelCapabilityHub.meta.source');
    }
}

function formatResourceTimestamp(timestamp: number): string {
    return new Intl.DateTimeFormat(getCurrentLanguage(), {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(timestamp));
}

const QuickPromptItemRow = React.memo(function QuickPromptItemRow(props: {
    item: QuickPromptCapabilityItem;
    onDelete?: (item: QuickPromptCapabilityItem) => void;
    onInsert?: (item: QuickPromptCapabilityItem) => void;
    onRun?: (item: QuickPromptCapabilityItem) => void;
}) {
    const { theme } = useUnistyles();

    return (
        <View style={[styles.rowCard, styles.quickPromptCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
            <Pressable
                disabled={!props.onInsert}
                onPress={() => props.onInsert?.(props.item)}
                style={({ pressed }) => [
                    styles.quickPromptMain,
                    { opacity: pressed ? 0.72 : 1 },
                ]}
            >
                <View style={[styles.rowIconWrap, { backgroundColor: theme.colors.surfaceHigh }]}>
                    <Ionicons color={theme.colors.text} name="chatbubble-ellipses-outline" size={15} />
                </View>
                <View style={styles.rowCopy}>
                    <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text }]}>
                        {props.item.title}
                    </Text>
                    <Text numberOfLines={2} style={[styles.rowMeta, { color: theme.colors.textSecondary }]}>
                        {props.item.prompt}
                    </Text>
                </View>
            </Pressable>
            <View style={styles.quickPromptActions}>
                {props.onRun ? (
                    <Pressable
                        hitSlop={8}
                        onPress={() => props.onRun?.(props.item)}
                        style={({ pressed }) => [
                            styles.sendButton,
                            { opacity: pressed ? 0.72 : 1 },
                        ]}
                    >
                        <Text style={[styles.sendText, { color: theme.colors.textLink }]}>
                            {t('rightPanelCapabilityHub.quickPrompt.send')}
                        </Text>
                    </Pressable>
                ) : null}
                {props.onDelete ? (
                    <Pressable
                        hitSlop={8}
                        onPress={() => props.onDelete?.(props.item)}
                        style={({ pressed }) => [
                            styles.deleteButton,
                            {
                                backgroundColor: theme.colors.surfaceHigh,
                                opacity: pressed ? 0.72 : 1,
                            },
                        ]}
                    >
                        <Ionicons color={theme.colors.textSecondary} name="trash-outline" size={15} />
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
});

const SkillItemRow = React.memo(function SkillItemRow(props: { title: string }) {
    const { theme } = useUnistyles();

    return (
        <View style={[styles.rowCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
            <View style={[styles.rowIconWrap, { backgroundColor: theme.colors.surfaceHigh }]}>
                <Ionicons color={theme.colors.text} name="flash-outline" size={15} />
            </View>
            <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text }]}>
                    {props.title}
                </Text>
                <Text numberOfLines={1} style={[styles.rowMeta, { color: theme.colors.textSecondary }]}>
                    {t('rightPanelCapabilityHub.meta.available')}
                </Text>
            </View>
        </View>
    );
});

const ImageItemRow = React.memo(function ImageItemRow(props: {
    item: ImageCapabilityItem;
    sessionId: string;
}) {
    const { theme } = useUnistyles();
    const { uri } = useAttachmentImage(props.sessionId, props.item.ref);
    const placeholder = React.useMemo(() => {
        if (!props.item.thumbhash) return undefined;
        const placeholderUri = thumbhashToDataUri(props.item.thumbhash);
        return placeholderUri ? { uri: placeholderUri } : undefined;
    }, [props.item.thumbhash]);
    const subtitle = props.item.width && props.item.height
        ? `${props.item.width} × ${props.item.height}`
        : t('rightPanelCapabilityHub.meta.image');
    const sourceLabel = props.item.source === 'generated'
        ? t('rightPanelCapabilityHub.meta.generatedImage')
        : t('rightPanelCapabilityHub.meta.image');

    return (
        <Pressable
            disabled={!uri}
            onPress={uri ? () => imageViewer.open({ uri, width: props.item.width, height: props.item.height, filename: props.item.title }) : undefined}
            style={({ pressed }) => [
                styles.rowCard,
                styles.imageRowCard,
                {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                    opacity: uri ? 1 : 0.78,
                    transform: [{ scale: pressed ? 0.99 : 1 }],
                },
            ]}
        >
            <View style={[styles.imageThumbWrap, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                <Image
                    source={uri ? { uri } : undefined}
                    placeholder={placeholder}
                    style={styles.imageThumb}
                    contentFit="cover"
                    transition={150}
                />
                {!uri && !placeholder ? (
                    <View style={styles.imageThumbOverlay}>
                        <Ionicons color={theme.colors.textSecondary} name="image-outline" size={20} />
                    </View>
                ) : null}
                {!uri ? (
                    <View style={styles.imageLoadingBadge}>
                        <ActivityIndicator color={theme.colors.textSecondary} size="small" />
                    </View>
                ) : null}
            </View>
            <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text }]}>
                    {props.item.title}
                </Text>
                <Text numberOfLines={1} style={[styles.rowMeta, { color: theme.colors.textSecondary }]}>
                    {props.item.width && props.item.height ? `${sourceLabel} · ${subtitle}` : subtitle}
                </Text>
            </View>
            {uri ? <Ionicons color={theme.colors.textSecondary} name="expand-outline" size={16} /> : null}
        </Pressable>
    );
});

const ArtifactItemRow = React.memo(function ArtifactItemRow(props: {
    item: ArtifactCapabilityItem;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();

    return (
        <Pressable
            onPress={() => router.push(`/artifacts/${props.item.artifactId}` as any)}
            style={({ pressed }) => [
                styles.rowCard,
                {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                    transform: [{ scale: pressed ? 0.99 : 1 }],
                },
            ]}
        >
            <View style={[styles.rowIconWrap, { backgroundColor: theme.colors.surfaceHigh }]}>
                <Ionicons color={theme.colors.text} name="document-text-outline" size={15} />
            </View>
            <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text }]}>
                    {props.item.title}
                </Text>
                <Text numberOfLines={1} style={[styles.rowMeta, { color: theme.colors.textSecondary }]}>
                    {t('rightPanelCapabilityHub.meta.artifact')}
                </Text>
            </View>
            <Ionicons color={theme.colors.textSecondary} name="chevron-forward" size={16} />
        </Pressable>
    );
});

const FileItemRow = React.memo(function FileItemRow(props: {
    item: FileCapabilityItem;
    sessionId: string;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();

    return (
        <Pressable
            onPress={() => router.push(`/session/${props.sessionId}/file?path=${btoa(props.item.path)}` as any)}
            style={({ pressed }) => [
                styles.rowCard,
                {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                    transform: [{ scale: pressed ? 0.99 : 1 }],
                },
            ]}
        >
            <View style={[styles.rowIconWrap, { backgroundColor: theme.colors.surfaceHigh }]}>
                <Octicons color={theme.colors.text} name="file-code" size={14} />
            </View>
            <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text }]}>
                    {props.item.title}
                </Text>
                <Text numberOfLines={1} style={[styles.rowMeta, { color: theme.colors.textSecondary }]}>
                    {props.item.path}
                </Text>
            </View>
            <Ionicons color={theme.colors.textSecondary} name="chevron-forward" size={16} />
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        flex: 1,
        minHeight: 0,
    },
    header: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 8,
        paddingBottom: 10,
        paddingHorizontal: 14,
        paddingTop: 10,
    },
    backButton: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 2,
    },
    backText: {
        fontSize: 13,
        fontWeight: '600',
    },
    headerCopy: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: 8,
        justifyContent: 'flex-end',
        minWidth: 0,
    },
    headerTitle: {
        fontSize: 17,
        fontWeight: '700',
    },
    headerMeta: {
        fontSize: 12,
        fontWeight: '600',
    },
    addButton: {
        alignItems: 'center',
        borderRadius: 14,
        height: 28,
        justifyContent: 'center',
        width: 28,
    },
    emptyWrap: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 18,
    },
    emptyText: {
        fontSize: 14,
        lineHeight: 20,
        textAlign: 'center',
    },
    emptyAction: {
        alignItems: 'center',
        borderRadius: 12,
        justifyContent: 'center',
        marginTop: 14,
        minHeight: 40,
        paddingHorizontal: 16,
    },
    emptyActionText: {
        fontSize: 14,
        fontWeight: '700',
    },
    scrollContent: {
        paddingHorizontal: 12,
        paddingVertical: 12,
        rowGap: 8,
    },
    rowCard: {
        alignItems: 'center',
        borderRadius: 16,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 10,
        minHeight: 64,
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    quickPromptCard: {
        alignItems: 'stretch',
        gap: 8,
        minHeight: 72,
        paddingRight: 10,
    },
    imageRowCard: {
        minHeight: 82,
        paddingVertical: 8,
    },
    quickPromptMain: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: 10,
        minWidth: 0,
    },
    quickPromptActions: {
        alignItems: 'center',
        flexDirection: 'row',
        flexShrink: 0,
        gap: 8,
        justifyContent: 'flex-end',
        width: 86,
    },
    rowIconWrap: {
        alignItems: 'center',
        borderRadius: 11,
        height: 30,
        justifyContent: 'center',
        width: 30,
    },
    imageThumbWrap: {
        borderRadius: 12,
        borderWidth: 1,
        height: 58,
        overflow: 'hidden',
        position: 'relative',
        width: 58,
    },
    imageThumb: {
        height: '100%',
        width: '100%',
    },
    imageThumbOverlay: {
        alignItems: 'center',
        bottom: 0,
        justifyContent: 'center',
        left: 0,
        position: 'absolute',
        right: 0,
        top: 0,
    },
    imageLoadingBadge: {
        alignItems: 'center',
        bottom: 4,
        height: 20,
        justifyContent: 'center',
        position: 'absolute',
        right: 4,
        width: 20,
    },
    rowCopy: {
        flex: 1,
        minWidth: 0,
    },
    rowTitle: {
        fontSize: 14,
        fontWeight: '600',
        marginBottom: 4,
    },
    rowMeta: {
        fontSize: 12,
        lineHeight: 16,
    },
    resourceStatus: {
        fontSize: 11,
        lineHeight: 15,
        marginTop: 2,
    },
    sendText: {
        fontSize: 12,
        fontWeight: '700',
    },
    sendButton: {
        alignItems: 'center',
        height: 34,
        justifyContent: 'center',
        minWidth: 36,
    },
    deleteButton: {
        alignItems: 'center',
        borderRadius: 17,
        height: 34,
        justifyContent: 'center',
        width: 34,
    },
}));
