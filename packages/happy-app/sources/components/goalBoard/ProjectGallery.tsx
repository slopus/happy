import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalProject } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardButton } from './GoalBoardButton';

// Original V2/V2.2 project artwork, bundled locally so cards do not need a third-party image service.
const covers = [
    require('@/assets/images/project-goals/paws.jpg'),
    require('@/assets/images/project-goals/creative.jpg'),
    require('@/assets/images/project-goals/harness.jpg'),
    require('@/assets/images/project-goals/mini.jpg'),
];
function coverFor(project: GoalProject) {
    if (/happy|paws/i.test(project.title)) return covers[0];
    let hash = 0;
    for (const char of project.projectPath.split('/').pop() || project.title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return covers[1 + hash % (covers.length - 1)];
}

function useGalleryLayout() {
    const [width, setWidth] = React.useState(0);
    const columns = Math.max(1, Math.min(3, Math.floor((width + 24) / 309)));
    const cardWidth = width ? (width - (columns - 1) * 24) / columns : 285;
    // Let CSS size web columns inside the actual scrollbar-adjusted content box.
    // onLayout can report the pre-scrollbar width during first mount.
    const gridStyle = Platform.OS === 'web' ? { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } as any : null;
    return { cardWidth: Platform.OS === 'web' ? '100%' as const : cardWidth, setWidth, gridStyle };
}

export function ProjectGalleryLoading() {
    const { cardWidth, setWidth, gridStyle } = useGalleryLayout();
    return <View style={[styles.grid, gridStyle]} onLayout={event => setWidth(Math.floor(event.nativeEvent.layout.width))}>
        {Array.from({ length: 6 }, (_, index) => <View key={index} style={{ width: cardWidth, maxWidth: '100%' }}>
            <View style={[styles.cover, styles.skeleton]} />
            <View style={styles.caption}><View style={[styles.skeletonLine, { width: '72%' }]} /><View style={[styles.skeletonLine, { width: '90%' }]} /></View>
        </View>)}
    </View>;
}

export function ProjectGallery({ projects, onSelect }: { projects: GoalProject[]; onSelect: (project: GoalProject) => void }) {
    const { theme } = useUnistyles();
    const { cardWidth, setWidth, gridStyle } = useGalleryLayout();
    return <View style={[styles.grid, gridStyle]} onLayout={event => setWidth(Math.floor(event.nativeEvent.layout.width))} testID="project-gallery">
        {projects.map((project, index) => <View key={project.projectPath} style={{ width: cardWidth, maxWidth: '100%' }}>
            <GoalBoardButton variant="card" label={project.title} onPress={() => onSelect(project)} testID={`project-cover-${index}`}>
                <View style={styles.cover}>
                    <Image source={coverFor(project)} contentFit="cover" style={StyleSheet.absoluteFillObject} accessibilityLabel={project.title} />
                    <View style={styles.coverTop}><Text style={styles.coverNumber}>GOAL FIRST / {String(index + 1).padStart(2, '0')}</Text></View>
                    <View style={styles.coverFooter}><Text style={styles.coverLabel}>{project.features.length ? `${project.features.length} ${t('projectGoals.subprojects')}` : t('projectGoals.directTasks')}</Text><Ionicons name="arrow-forward" size={16} color={theme.colors.text} /></View>
                </View>
                <View style={styles.caption}>
                    <Text numberOfLines={1} style={styles.title}>{project.title}</Text>
                    <Text numberOfLines={2} style={styles.description}>{project.summary || project.features.map(feature => feature.title).slice(0, 3).join(' · ') || t('projectGoals.directTasks')}</Text>
                    <View style={styles.meta}><Ionicons name="folder-open-outline" size={13} color={theme.colors.textSecondary} /><Text style={styles.metaText}>{project.features.length ? t('projectGoals.subprojects') : t('projectGoals.tasks')}</Text><Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} /></View>
                </View>
            </GoalBoardButton>
        </View>)}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 24, width: '100%' },
    skeleton: { backgroundColor: theme.colors.surfaceSelected },
    skeletonLine: { height: 12, borderRadius: 6, backgroundColor: theme.colors.surfaceSelected },
    cover: { width: '100%', aspectRatio: 8 / 5, backgroundColor: theme.colors.surfaceHigh, borderRadius: 13, overflow: 'hidden', justifyContent: 'space-between', padding: 16 },
    coverTop: { alignSelf: 'flex-start', backgroundColor: theme.colors.surface, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 6 },
    coverNumber: { color: theme.colors.textSecondary, fontSize: 9, letterSpacing: 1.5, ...Typography.default('semiBold') },
    coverFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'flex-start', gap: 20, backgroundColor: theme.colors.surface, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 7 },
    coverLabel: { color: theme.colors.text, fontSize: 11, ...Typography.default() },
    caption: { paddingHorizontal: 4, paddingTop: 14, paddingBottom: 12, gap: 7 },
    title: { fontSize: 16, lineHeight: 24, color: theme.colors.text, ...Typography.default('semiBold') },
    description: { minHeight: 40, fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
    meta: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingTop: 6 },
    metaText: { flex: 1, fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() },
}));
