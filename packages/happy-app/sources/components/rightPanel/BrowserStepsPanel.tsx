import * as React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { t } from '@/text';
import type { BrowserStep } from './browserStepsModel';
import type { ImageViewerSource } from '@/sync/imageViewer';

function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(timestamp);
}

type StepImageSourceProps = {
    sessionId?: string;
    step: BrowserStep;
    maxDimension?: number;
    children: (image: { uri: string | null; loading: boolean }) => React.ReactNode;
};

function PrivateStepImageSource(props: StepImageSourceProps & { sessionId: string }) {
    const image = useAttachmentImage(props.sessionId, props.step.ref, { maxDimension: props.maxDimension });
    return <>{props.children(image)}</>;
}

function StepImageSource(props: StepImageSourceProps) {
    // Anonymous public URLs must never enter the authenticated attachment loader.
    return props.sessionId
        ? <PrivateStepImageSource {...props} sessionId={props.sessionId} />
        : <>{props.children({ uri: props.step.ref, loading: false })}</>;
}

const BrowserStepPreview = React.memo(function BrowserStepPreview(props: {
    sessionId?: string;
    step: BrowserStep;
    onOpenImage: (source: ImageViewerSource) => void;
    imageButtonRef?: React.RefObject<View | null>;
}) {
    const { theme } = useUnistyles();
    return <StepImageSource sessionId={props.sessionId} step={props.step}>{({ uri, loading }) => (
        <Pressable
            ref={props.imageButtonRef}
            testID="browser-step-open-image"
            accessibilityRole="button"
            accessibilityLabel={props.step.label}
            onPress={() => props.onOpenImage({
                uri: uri ?? '', ...(props.sessionId ? { sessionId: props.sessionId, attachmentRef: props.step.ref } : {}),
                filename: props.step.name, width: props.step.width, height: props.step.height,
            })}
            style={({ pressed }) => [styles.preview, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}
        >
            {uri ? (
                <Image resizeMode="contain" source={{ uri }} style={styles.previewImage} />
            ) : (
                <View style={styles.previewPlaceholder}>
                    {loading ? <ActivityIndicator color={theme.colors.textSecondary} size="small" /> : <Ionicons color={theme.colors.textSecondary} name="image-outline" size={28} />}
                </View>
            )}
            <View style={styles.openIcon} pointerEvents="none">
                <Ionicons name="expand-outline" size={18} color={theme.colors.text} />
            </View>
        </Pressable>
    )}</StepImageSource>;
});

const BrowserStepThumbnail = React.memo(function BrowserStepThumbnail(props: {
    sessionId?: string;
    step: BrowserStep;
}) {
    const { theme } = useUnistyles();
    return <StepImageSource sessionId={props.sessionId} step={props.step} maxDimension={96}>{({ uri }) => (
        <View style={[styles.thumbnail, { backgroundColor: theme.colors.surfaceHigh }]}>
            {uri ? <Image resizeMode="cover" source={{ uri }} style={styles.thumbnailImage} /> : <Ionicons color={theme.colors.textSecondary} name="image-outline" size={16} />}
        </View>
    )}</StepImageSource>;
});

export const BrowserStepsPanel = React.memo(function BrowserStepsPanel(props: {
    sessionId?: string;
    steps: BrowserStep[];
    onOpenImage: (source: ImageViewerSource) => void;
    imageButtonRef?: React.RefObject<View | null>;
}) {
    const { theme } = useUnistyles();
    const latestId = props.steps.at(-1)?.id ?? null;
    const [selectedId, setSelectedId] = React.useState<string | null>(latestId);

    React.useEffect(() => {
        setSelectedId(latestId);
    }, [latestId]);

    const selected = props.steps.find((step) => step.id === selectedId) ?? props.steps.at(-1);
    if (!selected) return null;

    return (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} style={styles.scroll} testID="browser-steps-timeline-scroll">
            <View style={styles.heading}>
                <View style={[styles.headingIcon, { backgroundColor: theme.colors.surfaceHigh }]}>
                    <Ionicons color={theme.colors.text} name="globe-outline" size={17} />
                </View>
                <View style={styles.headingCopy}>
                    <Text style={[styles.title, { color: theme.colors.text }]}>{t('rightPanelCapabilityHub.browserProgress.timelineTitle')}</Text>
                    <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>{t('rightPanelCapabilityHub.browserProgress.liveCount', { count: props.steps.length })}</Text>
                </View>
            </View>

            <BrowserStepPreview sessionId={props.sessionId} step={selected} onOpenImage={props.onOpenImage} imageButtonRef={props.imageButtonRef} />
            <View style={styles.activeCopy}>
                <Text style={[styles.activeLabel, { color: theme.colors.text }]} numberOfLines={2}>
                    {selected.label}
                </Text>
                <Text style={[styles.activeMeta, { color: theme.colors.textSecondary }]}>
                    {t('rightPanelCapabilityHub.browserProgress.stepPosition', {
                        current: props.steps.findIndex((step) => step.id === selected.id) + 1,
                        total: props.steps.length,
                    })} · {formatTime(selected.createdAt)}
                </Text>
            </View>

            <View style={styles.timeline}>
                {props.steps.map((step, index) => {
                    const active = step.id === selected.id;
                    return (
                        <Pressable
                            accessibilityRole="button"
                            key={step.id}
                            onPress={() => setSelectedId(step.id)}
                            style={({ pressed }) => [styles.stepRow, { opacity: pressed ? 0.72 : 1 }]}
                        >
                            <View style={styles.timelineMarker}>
                                <View style={[styles.stepNumber, { backgroundColor: active ? theme.colors.surfaceSelected : theme.colors.surfaceHigh }]}>
                                    <Text style={[styles.stepNumberText, { color: active ? theme.colors.text : theme.colors.textSecondary }]}>{index + 1}</Text>
                                </View>
                                {index < props.steps.length - 1 ? <View style={[styles.timelineLine, { backgroundColor: theme.colors.divider }]} /> : null}
                            </View>
                            <View style={[styles.stepCard, { backgroundColor: active ? theme.colors.surfaceSelected : theme.colors.surface, borderColor: active ? theme.colors.textSecondary : theme.colors.divider }]}>
                                <View style={styles.stepCopy}>
                                    <Text style={[styles.stepLabel, { color: theme.colors.text }]} numberOfLines={2}>{step.label}</Text>
                                    <Text style={[styles.stepMeta, { color: theme.colors.textSecondary }]}>{formatTime(step.createdAt)}</Text>
                                </View>
                                <BrowserStepThumbnail sessionId={props.sessionId} step={step} />
                            </View>
                        </Pressable>
                    );
                })}
            </View>
        </ScrollView>
    );
});

const styles = StyleSheet.create(() => ({
    scroll: { flex: 1, minHeight: 0 },
    content: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 28 },
    heading: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
    headingIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    headingCopy: { marginLeft: 10, flex: 1 },
    title: { fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
    subtitle: { fontSize: 12, marginTop: 2 },
    preview: { height: 186, borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
    previewImage: { width: '100%', height: '100%' },
    openIcon: { position: 'absolute', right: 8, bottom: 8 },
    previewPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    activeCopy: { marginTop: 10, marginBottom: 18 },
    activeLabel: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
    activeMeta: { fontSize: 12, marginTop: 4 },
    timeline: { gap: 0 },
    stepRow: { flexDirection: 'row', minHeight: 78 },
    timelineMarker: { alignItems: 'center', width: 30 },
    stepNumber: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
    stepNumberText: { fontSize: 11, fontWeight: '700' },
    timelineLine: { width: 1, flex: 1, marginVertical: 3 },
    stepCard: { flex: 1, minHeight: 68, borderWidth: 1, borderRadius: 12, marginLeft: 2, marginBottom: 10, padding: 8, flexDirection: 'row', alignItems: 'center' },
    stepCopy: { flex: 1, paddingRight: 8 },
    stepLabel: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
    stepMeta: { fontSize: 11, marginTop: 4 },
    thumbnail: { width: 62, height: 48, borderRadius: 7, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbnailImage: { width: '100%', height: '100%' },
}));
