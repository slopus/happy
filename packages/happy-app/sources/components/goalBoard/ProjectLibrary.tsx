import * as React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalProject } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { filterProjectLibrary, getProjectLibraryRevision, projectLibraryOwner, readProjectLibrary, subscribeProjectLibrary, updateProjectLibrary, type ProjectLibraryFilter } from '@/sync/projectLibrary';
import { GoalBoardButton } from './GoalBoardButton';
import { ProjectGallery } from './ProjectGallery';

const filters = ['all', 'favorites', 'archived', 'deleted'] as const;
const filterKeys = { all: 'allProjects', favorites: 'favorites', archived: 'archivedProjects', deleted: 'deletedProjects' } as const;
const filterIcons = { all: 'grid-outline', favorites: 'star-outline', archived: 'archive-outline', deleted: 'trash-outline' } as const;
const views = new Map<string, ProjectLibraryFilter>();

/** Personal organization never mutates the machine's source archive or conversations. */
export function ProjectLibrary({ machineId, projects, query, loaded, onSelect }: { machineId: string; projects: GoalProject[]; query: string; loaded: boolean; onSelect: (project: GoalProject) => void }) {
    const { theme } = useUnistyles();
    const revision = React.useSyncExternalStore(subscribeProjectLibrary, getProjectLibraryRevision, getProjectLibraryRevision);
    const preferences = React.useMemo(() => readProjectLibrary(machineId), [machineId, revision]);
    const viewKey = JSON.stringify([projectLibraryOwner(), machineId]);
    const [filter, updateFilter] = React.useState<ProjectLibraryFilter>(() => views.get(viewKey) ?? 'all');
    const setFilter = (value: ProjectLibraryFilter) => {
        updateFilter(value); views.set(viewKey, value);
        if (views.size > 100) views.delete(views.keys().next().value!);
    };
    const visible = filterProjectLibrary(projects, preferences, filter, query);
    const alive = React.useRef(true);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const owner = projectLibraryOwner();
    const update = (project: GoalProject, patch: Parameters<typeof updateProjectLibrary>[2]) => {
        if (!alive.current || owner !== projectLibraryOwner()) return;
        try { updateProjectLibrary(machineId, project.projectPath, patch, owner); }
        catch { Modal.alert(t('common.error'), t('projectGoals.librarySaveFailed')); }
    };
    return <View style={styles.library}>
        <View style={styles.filters} testID="project-library-filters">
            {filters.map(value => <GoalBoardButton key={value} variant="chip" selected={filter === value} label={t(`projectGoals.${filterKeys[value]}`)} testID={`project-filter-${value}`} onPress={() => setFilter(value)}>
                <Ionicons name={filterIcons[value]} size={15} color={filter === value ? theme.colors.text : theme.colors.textSecondary} />
                <Text style={[styles.filterText, filter === value && { color: theme.colors.text }]}>{t(`projectGoals.${filterKeys[value]}`)}</Text>
                <Text style={styles.count}>{loaded ? filterProjectLibrary(projects, preferences, value).length : '—'}</Text>
            </GoalBoardButton>)}
        </View>
        <View style={styles.heading}><Text style={styles.headingText}>{t('projectGoals.projectLibrary')}</Text><Text style={styles.count}>{loaded ? visible.length : '—'}</Text></View>
        <ProjectGallery projects={visible} onSelect={onSelect} preferences={preferences} onFavorite={project => update(project, { favorite: !preferences[project.projectPath]?.favorite })}
            onArchive={project => update(project, { state: preferences[project.projectPath]?.state === 'archived' ? 'active' : 'archived' })}
            onRestore={project => update(project, { state: 'active' })}
            onDelete={async project => {
                if (await Modal.confirm(t('projectGoals.deleteProject'), t('projectGoals.deleteProjectMessage', { title: project.title }), { destructive: true, confirmText: t('common.delete') })) update(project, { state: 'deleted' });
            }} />
        {loaded && !visible.length && <View style={styles.empty} testID="project-library-empty"><Ionicons name={query.trim() ? 'search-outline' : filterIcons[filter]} size={28} color={theme.colors.textSecondary} /><Text style={styles.emptyTitle}>{t(query.trim() ? 'projectGoals.noMatchingProjects' : filter === 'favorites' ? 'projectGoals.noFavorites' : filter === 'archived' ? 'projectGoals.noArchivedProjects' : filter === 'deleted' ? 'projectGoals.noDeletedProjects' : 'projectGoals.emptyProjects')}</Text>
            {filter === 'favorites' && !query.trim() && <Text style={styles.filterText}>{t('projectGoals.favoriteHint')}</Text>}
        </View>}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    library: { gap: 18, width: '100%' },
    filters: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    filterText: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    count: { fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() },
    heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    headingText: { fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    empty: { paddingVertical: 48, paddingHorizontal: 16, gap: 12, alignItems: 'center' },
    emptyTitle: { fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') },
}));
