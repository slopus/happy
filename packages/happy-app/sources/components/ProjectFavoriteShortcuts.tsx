import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useGlobalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { Typography } from '@/constants/Typography';
import { useDesktopWorkspacePathname } from '@/hooks/useDesktopWorkspacePathname';
import { useProjectFavoriteShortcuts } from '@/hooks/useProjectFavoriteShortcuts';
import { useLocalSetting } from '@/sync/storage';
import { projectLibraryOwner } from '@/sync/projectLibrary';
import { restoreProjectLocation } from '@/utils/projectReturnLocation';
import { selectedProjectFavorite } from '@/utils/projectFavoriteShortcuts';
import { t } from '@/text';
import { GoalBoardButton } from './goalBoard/GoalBoardButton';

/** Persistent bookmark strip in the spare space beside the desktop navigation controls. */
export const ProjectFavoriteShortcuts = React.memo(function ProjectFavoriteShortcuts() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = useDesktopWorkspacePathname();
    const params = useGlobalSearchParams();
    const saved = useLocalSetting('desktopProjectLocation');
    const rememberedMachine = new URL(restoreProjectLocation(saved), 'https://paws.invalid').searchParams.get('machine') ?? undefined;
    const projectWorkspace = pathname === '/projects';
    const routeMachine = projectWorkspace ? typeof params.machine === 'string' ? params.machine : undefined : rememberedMachine;
    const { machineId, owner, shortcuts } = useProjectFavoriteShortcuts(routeMachine);
    const selected = projectWorkspace ? selectedProjectFavorite(shortcuts, {
        machine: machineId, project: typeof params.project === 'string' ? params.project : undefined,
        feature: typeof params.feature === 'string' ? params.feature : undefined,
    }) : undefined;
    const canNavigate = () => accountRuntimeCurrent() && owner === projectLibraryOwner();
    return <View style={styles.container} testID="desktop-project-favorites">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll}
            contentContainerStyle={styles.content} accessibilityLabel={t('projectGoals.favorites')}>
            {shortcuts.length ? shortcuts.map(shortcut => <View key={shortcut.key} style={styles.shortcut}>
                <GoalBoardButton variant="toolbar" label={shortcut.title} tooltip={`${shortcut.title}\n${shortcut.path}`} tooltipPortal
                    selected={shortcut.key === selected} testID={`desktop-project-favorite-${shortcut.key}`}
                    onPress={() => {
                        if (shortcut.key === selected || !canNavigate()) return;
                        // A full destination clears the previous task, conversation and file parameters.
                        router.push({ pathname: '/projects', params: Object.fromEntries(Object.entries(shortcut.location).filter(([, value]) => value !== undefined)) });
                    }}>
                    <Ionicons name={shortcut.key === selected ? 'star' : 'star-outline'} size={14}
                        color={shortcut.key === selected ? theme.colors.textLink : theme.colors.textSecondary} />
                    <Text numberOfLines={1} style={[styles.title, shortcut.key === selected && styles.selectedTitle]}>{shortcut.title}</Text>
                </GoalBoardButton>
            </View>) : <GoalBoardButton variant="toolbar" label={t('projectGoals.favoriteHint')} tooltip={t('projectGoals.favoriteHint')} tooltipPortal
                testID="desktop-project-favorites-empty" onPress={() => { if (canNavigate()) router.push({ pathname: '/projects', params: machineId ? { machine: machineId } : {} }); }}>
                <Ionicons name="star-outline" size={14} color={theme.colors.textSecondary} />
                <Text numberOfLines={1} style={styles.title}>{t('projectGoals.favorites')}</Text>
            </GoalBoardButton>}
        </ScrollView>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    container: { flex: 1, minWidth: 0, marginLeft: 16, marginRight: 40, height: 40, pointerEvents: 'auto' },
    scroll: { flex: 1, minWidth: 0 },
    content: { alignItems: 'center', gap: 6, paddingHorizontal: 2 },
    shortcut: { maxWidth: 220, flexShrink: 0 },
    title: { flexShrink: 1, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
    selectedTitle: { color: theme.colors.text, ...Typography.default('semiBold') },
}));
