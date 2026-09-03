import * as React from 'react';
import { Image, Linking, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import type { PublicSessionAppearanceMode } from '@/hooks/usePublicSessionAppearance';
import { publicSessionSnapshotToMessages } from '@/sync/publicSessionSnapshotAdapter';
import { getPublicSessionAttachmentUrl } from '@/sync/publicSessionShareViewer';
import type { PublicSessionSnapshot } from '@/sync/publicSessionShareTypes';
import { publicSessionShareText as t } from '@/text/publicSessionShareText';
import { ConversationTranscript } from './ConversationTranscript';
import { DesktopShortcutTooltip } from './DesktopShortcutTooltip';

export function PublicSessionTranscript({
    publicId,
    publishedAt,
    snapshot,
    appearanceMode,
    onAppearanceModeChange,
}: {
    publicId: string;
    publishedAt: number;
    snapshot: PublicSessionSnapshot;
    appearanceMode: PublicSessionAppearanceMode;
    onAppearanceModeChange: (mode: PublicSessionAppearanceMode) => void;
}) {
    const messages = React.useMemo(() => publicSessionSnapshotToMessages(snapshot, {
        attachmentUrl: (attachmentId) => getPublicSessionAttachmentUrl(publicId, attachmentId),
    }), [publicId, snapshot]);
    const cover = snapshot.version === 2 ? snapshot.appearance.cover : undefined;
    return (
        <View style={styles.page} testID="public-session-transcript">
            {cover ? <PublicTranscriptCover publicId={publicId} cover={cover} /> : null}
            <PublicTranscriptHeader
                title={snapshot.title}
                publishedAt={publishedAt}
                source={snapshot.source?.provider}
                appearanceMode={appearanceMode}
                onAppearanceModeChange={onAppearanceModeChange}
            />
            <View style={styles.transcript} testID="public-session-transcript-scroll-region">
                <ConversationTranscript
                    metadata={null}
                    messages={messages}
                    groupToolCalls={snapshot.presentation?.groupToolCalls ?? true}
                    currentTurnActive={false}
                    hasPendingPermission={false}
                    visualTop={<View style={styles.transcriptTopInset} />}
                    visualBottom={<View style={styles.transcriptBottomInset} />}
                    showMessageActions={false}
                    canEditLatestUserMessage={false}
                    showAnchorNavigation={false}
                    inverted={false}
                    contentContainerStyle={styles.transcriptContent}
                />
            </View>
        </View>
    );
}

type PublicSessionCover = Extract<PublicSessionSnapshot, { version: 2 }>['appearance']['cover'];

function PublicTranscriptCover({ publicId, cover }: { publicId: string; cover: NonNullable<PublicSessionCover> }) {
    const attribution = cover.attribution;
    return (
        <View style={styles.coverBoundary} testID="public-session-cover">
            <View style={styles.coverFrame}>
                <Image
                    accessibilityLabel={t('sessionShare.coverPreview')}
                    resizeMode="cover"
                    source={{ uri: getPublicSessionAttachmentUrl(publicId, cover.assetId) }}
                    style={styles.coverImage}
                    testID="public-session-cover-image"
                />
                {attribution ? (
                    <Pressable
                        accessibilityLabel={t('sessionShare.coverAttribution', { photographer: attribution.photographer })}
                        accessibilityRole="link"
                        onPress={() => { void Linking.openURL(attribution.photoUrl); }}
                        style={({ pressed }) => [styles.attribution, pressed && styles.attributionPressed]}
                        testID="public-session-cover-attribution"
                    >
                        <Text numberOfLines={1} style={styles.attributionText}>
                            {t('sessionShare.coverAttribution', { photographer: attribution.photographer })}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
}

const sourceLabels = {
    paws: 'Paws',
    codex: 'Codex',
    'claude-code': 'Claude Code',
} as const;

function PublicTranscriptHeader({
    title,
    publishedAt,
    source,
    appearanceMode,
    onAppearanceModeChange,
}: {
    title: string;
    publishedAt: number;
    source?: keyof typeof sourceLabels;
    appearanceMode: PublicSessionAppearanceMode;
    onAppearanceModeChange: (mode: PublicSessionAppearanceMode) => void;
}) {
    return (
        <View style={styles.headerBoundary} testID="public-session-compact-header">
            <View style={styles.headerFrame} testID="public-session-header-inner">
                <View style={styles.brandMark} testID="public-session-header-mark">
                    <Ionicons
                        testID="public-session-header-icon"
                        name="document-text-outline"
                        size={22}
                        color={styles.brandMarkIcon.color}
                    />
                    <Ionicons
                        name="sparkles-outline"
                        size={11}
                        color={styles.brandSparkle.color}
                        style={styles.brandSparkle}
                    />
                </View>
                <View style={styles.headerCopy}>
                    <Text
                        testID="public-session-title"
                        accessibilityRole="header"
                        numberOfLines={1}
                        style={styles.title}
                    >
                        {title}
                    </Text>
                    <View style={styles.dateRow}>
                        {source ? (
                            <Text numberOfLines={1} style={styles.source} testID="public-session-source-label">
                                {sourceLabels[source]}
                            </Text>
                        ) : null}
                        <Ionicons
                            testID="public-session-time-icon"
                            name="time-outline"
                            size={13}
                            color={styles.date.color}
                        />
                        <Text testID="public-session-published-at" numberOfLines={1} style={styles.date}>
                            {new Date(publishedAt).toLocaleString()}
                        </Text>
                    </View>
                </View>
                <PublicAppearanceModeControl mode={appearanceMode} onChange={onAppearanceModeChange} />
            </View>
        </View>
    );
}

const modeOptions = [
    { mode: 'light', icon: 'sunny-outline', label: 'sessionShare.appearanceLight' },
    { mode: 'dark', icon: 'moon-outline', label: 'sessionShare.appearanceDark' },
    { mode: 'system', icon: 'desktop-outline', label: 'sessionShare.appearanceSystem' },
] as const;

function PublicAppearanceModeControl({
    mode,
    onChange,
}: {
    mode: PublicSessionAppearanceMode;
    onChange: (mode: PublicSessionAppearanceMode) => void;
}) {
    const [hoveredMode, setHoveredMode] = React.useState<PublicSessionAppearanceMode | null>(null);
    const [focusedMode, setFocusedMode] = React.useState<PublicSessionAppearanceMode | null>(null);

    return (
        <View
            accessibilityLabel={t('sessionShare.appearance')}
            style={styles.modeControl}
            testID="public-session-appearance-mode"
        >
            {modeOptions.map((option) => {
                const selected = option.mode === mode;
                return (
                    <Pressable
                        aria-pressed={selected}
                        accessibilityLabel={t(option.label)}
                        accessibilityRole="button"
                        hitSlop={4}
                        key={option.mode}
                        onBlur={() => setFocusedMode((current) => current === option.mode ? null : current)}
                        onFocus={() => setFocusedMode(option.mode)}
                        onHoverIn={() => setHoveredMode(option.mode)}
                        onHoverOut={() => setHoveredMode((current) => current === option.mode ? null : current)}
                        onPress={() => onChange(option.mode)}
                        style={({ pressed }) => [
                            styles.modeButton,
                            selected && styles.modeButtonSelected,
                            pressed && styles.modeButtonPressed,
                        ]}
                    >
                        <Ionicons name={option.icon} size={14} color={styles.modeIcon.color} />
                        {Platform.OS === 'web' ? (
                            <DesktopShortcutTooltip
                                align="center"
                                compact
                                label={t(option.label)}
                                testID={`public-session-appearance-tooltip-${option.mode}`}
                                visible={hoveredMode === option.mode || focusedMode === option.mode}
                            />
                        ) : null}
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    transcript: {
        flex: 1,
        width: '100%',
    },
    transcriptContent: {
        width: '100%',
        maxWidth: layout.maxWidth - 40,
        alignSelf: 'center',
    },
    coverBoundary: {
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingTop: 20,
        backgroundColor: theme.colors.groupped.background,
    },
    coverFrame: {
        position: 'relative',
        width: '100%',
        maxWidth: layout.maxWidth - 40,
        aspectRatio: 16 / 5,
        maxHeight: 260,
        overflow: 'hidden',
        borderRadius: 16,
        backgroundColor: theme.colors.surfaceHigh,
    },
    coverImage: {
        width: '100%',
        height: '100%',
    },
    attribution: {
        position: 'absolute',
        right: 10,
        bottom: 10,
        maxWidth: '80%',
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    attributionPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    attributionText: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        lineHeight: 14,
    },
    headerBoundary: {
        alignItems: 'center',
        paddingHorizontal: 20,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
    },
    headerFrame: {
        width: '100%',
        maxWidth: layout.maxWidth - 40,
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 82,
        paddingVertical: 16,
        gap: 10,
    },
    brandMark: {
        position: 'relative',
        width: 30,
        height: 30,
        alignItems: 'center',
        justifyContent: 'center',
    },
    brandMarkIcon: { color: theme.colors.textSecondary },
    brandSparkle: {
        position: 'absolute',
        right: -2,
        top: -2,
        color: theme.colors.accent,
    },
    headerCopy: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text,
        fontSize: 22,
        lineHeight: 28,
        fontWeight: '600' as const,
    },
    dateRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 2,
    },
    source: {
        color: theme.colors.accent,
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '600' as const,
    },
    date: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
    },
    modeControl: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: 2,
        padding: 3,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    modeButton: {
        position: 'relative',
        width: 26,
        height: 26,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
    },
    modeButtonSelected: { backgroundColor: theme.colors.surfaceSelected },
    modeButtonPressed: { backgroundColor: theme.colors.surfacePressed },
    modeIcon: { color: theme.colors.textSecondary },
    transcriptTopInset: { height: 22 },
    transcriptBottomInset: { height: 34 },
}));
