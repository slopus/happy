import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { GoalBoardCatalogEntry } from '@slopus/happy-wire';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { ProjectFeatureGallery } from './ProjectGallery';
import { ProjectSavedItems } from './ProjectSavedItems';
import { useLibraryItems } from '@/hooks/useLibraryItems';

export function ProjectFeatureLibrary({ machineId, entries, projectPath, query, onSelect }: { machineId: string; entries: GoalBoardCatalogEntry[]; projectPath: string; query: string; onSelect: (entry: GoalBoardCatalogEntry) => void }) {
    const { theme } = useUnistyles();
    const library = useLibraryItems(machineId);
    const [deleted, setDeleted] = React.useState(false);
    const matching = entries.filter(entry => (entry.title + (entry.summary ?? '')).toLowerCase().includes(query.trim().toLowerCase()));
    const visible = matching.filter(entry => (library.stateOf({ kind: 'feature', projectPath: entry.featurePath })?.state === 'deleted') === deleted);
    return <View style={{ gap: 16 }} testID="project-feature-library">
        <View style={{ flexDirection: 'row', gap: 8 }}><Button variant="chip" selected={!deleted} label={t('projectGoals.subprojects')} onPress={() => setDeleted(false)}><Text style={{ color: theme.colors.text }}>{t('projectGoals.subprojects')}</Text></Button><Button variant="chip" selected={deleted} label={t('projectGoals.deletedProjects')} onPress={() => setDeleted(true)} testID="feature-filter-deleted"><Text style={{ color: theme.colors.text }}>{t('projectGoals.deletedProjects')}</Text></Button></View>
        {deleted ? <ProjectSavedItems items={visible.map(entry => ({ ...library.stateOf({ kind: 'feature', projectPath: entry.featurePath })!, title: entry.title }))} library={library} onOpen={() => {}} /> : <ProjectFeatureGallery entries={visible} projectPath={projectPath} onSelect={onSelect} library={library} />}
        {!visible.length && <Text style={{ padding: 16, color: theme.colors.textSecondary }}>{t('projectGoals.noMatchingItems')}</Text>}
    </View>;
}
