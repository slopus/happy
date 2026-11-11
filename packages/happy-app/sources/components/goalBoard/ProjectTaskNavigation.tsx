import * as React from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalTask } from '@slopus/happy-wire';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { ProjectTaskStatus } from './ProjectTaskStatus';

/** The Task index stays mounted beside the conversation and document workspace. */
export function ProjectTaskNavigation({ tasks, selectedId, query, setQuery, onSelect, onCollapse, scrollPosition, width, surface }: {
    tasks: GoalTask[]; selectedId: string; query: string; setQuery: (value: string) => void;
    onSelect: (id: string) => void; onCollapse: () => void; scrollPosition: React.MutableRefObject<number>;
    width: number; surface: string;
}) {
    const { theme } = useUnistyles();
    const scroll = React.useRef<ScrollView>(null);
    const visible = tasks.filter(task => `${task.code ?? ''} ${task.title} ${task.goal}`.toLowerCase().includes(query.toLowerCase()));
    React.useLayoutEffect(() => { scroll.current?.scrollTo({ y: scrollPosition.current, animated: false }); }, []);
    return <View testID="project-task-navigation" style={[styles.panel, { width, backgroundColor: surface }]}>
        <View style={styles.header}><Text style={styles.heading}>{t('projectGoals.backTasks')}</Text><Text style={styles.count}>{tasks.length}</Text><View style={{ flex: 1 }} />
            <Button variant="toolbar" label={t('projectGoals.collapseTasks')} onPress={onCollapse} testID="project-task-navigation-collapse"><Ionicons name="chevron-back" size={16} color={theme.colors.textSecondary} /></Button>
        </View>
        <View style={styles.searchRow}><Ionicons name="search-outline" size={14} color={theme.colors.textSecondary} /><TextInput value={query} onChangeText={setQuery} placeholder={t('projectGoals.search')} accessibilityLabel={t('projectGoals.search')} placeholderTextColor={theme.colors.textSecondary} style={styles.search} /></View>
        <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={styles.list} onScroll={event => { scrollPosition.current = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100}>
            {visible.map(task => <Button key={task.id} variant="row" selected={selectedId === task.id} label={task.title} onPress={() => onSelect(task.id)} testID={`project-task-navigation-${task.id}`}>
                <View style={styles.status}><ProjectTaskStatus status={task.status} /></View><View style={styles.rowContent}><Text style={styles.code}>{task.code || String(tasks.indexOf(task) + 1).padStart(2, '0')}</Text><Text numberOfLines={3} style={styles.title}>{task.title}</Text></View>
                {selectedId === task.id && <Ionicons name="chevron-forward" size={13} color={theme.colors.textLink} />}
            </Button>)}
            {!visible.length && <Text style={styles.empty}>{t('goalBoard.noMatches')}</Text>}
        </ScrollView>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    panel: { flexShrink: 0, minHeight: 0, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, overflow: 'hidden', marginRight: 10 },
    header: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingLeft: 14, paddingRight: 5, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    heading: { color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') },
    count: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
    searchRow: { flexDirection: 'row', alignItems: 'center', margin: 10, paddingHorizontal: 10, borderRadius: 8, backgroundColor: theme.colors.input.background, gap: 7 },
    search: { flex: 1, minWidth: 0, paddingVertical: 10, color: theme.colors.text, fontSize: 12, ...Typography.default() },
    list: { paddingHorizontal: 7, paddingBottom: 12, gap: 5 },
    status: { paddingTop: 13 }, rowContent: { flex: 1, minWidth: 0, gap: 5 },
    code: { fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() },
    title: { fontSize: 13, lineHeight: 20, color: theme.colors.text, ...Typography.default('semiBold') },
    empty: { color: theme.colors.textSecondary, fontSize: 12, padding: 14, ...Typography.default() },
}));
