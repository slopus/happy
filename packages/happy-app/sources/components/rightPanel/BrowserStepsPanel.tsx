import * as React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import type { BrowserStep } from './browserStepsModel';

function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(timestamp);
}

const BrowserStepPreview = React.memo(function BrowserStepPreview(props: {
    sessionId: string;
    step: BrowserStep;
}) {
    const { theme } = useUnistyles();
    const { uri, loading } = useAttachmentImage(props.sessionId, props.step.ref);
    return (
        <View style={[styles.preview, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
            {uri ? (
                <Image resizeMode="contain" source={{ uri }} style={styles.previewImage} />
            ) : (
                <View style={styles.previewPlaceholder}>
                    {loading ? <ActivityIndicator color={theme.colors.textSecondary} size="small" /> : <Ionicons color={theme.colors.textSecondary} name="image-outline" size={28} />}
                </View>
            )}
        </View>
    );
});

const BrowserStepThumbnail = React.memo(function BrowserStepThumbnail(props: {
    sessionId: string;
    step: BrowserStep;
}) {
    const { theme } = useUnistyles();
    const { uri } = useAttachmentImage(props.sessionId, props.step.ref, { maxDimension: 96 });
    return (
        <View style={[styles.thumbnail, { backgroundColor: theme.colors.surfaceHigh }]}>
            {uri ? <Image resizeMode="cover" source={{ uri }} style={styles.thumbnailImage} /> : <Ionicons color={theme.colors.textSecondary} name="image-outline" size={16} />}
        </View>
    );
});

export const BrowserStepsPanel = React.memo(function BrowserStepsPanel(props: {
    sessionId: string;
    steps: BrowserStep[];
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
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.heading}>
                <View style={[styles.headingIcon, { backgroundColor: theme.colors.surfaceHigh }]}>
                    <Ionicons color={theme.colors.text} name="globe-outline" size={17} />
                </View>
                <View style={styles.headingCopy}>
                    <Text style={[styles.title, { color: theme.colors.text }]}>浏览器步骤</Text>
                    <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>实时回显 · {props.steps.length} 步</Text>
                </View>
            </View>

            <BrowserStepPreview sessionId={props.sessionId} step={selected} />
            <View style={styles.activeCopy}>
                <Text style={[styles.activeLabel, { color: theme.colors.text }]} numberOfLines={2}>
                    {selected.label}
                </Text>
                <Text style={[styles.activeMeta, { color: theme.colors.textSecondary }]}>第 {props.steps.findIndex((step) => step.id === selected.id) + 1} 步 · {formatTime(selected.createdAt)}</Text>
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
    content: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 28 },
    heading: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
    headingIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    headingCopy: { marginLeft: 10, flex: 1 },
    title: { fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
    subtitle: { fontSize: 12, marginTop: 2 },
    preview: { height: 186, borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
    previewImage: { width: '100%', height: '100%' },
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
