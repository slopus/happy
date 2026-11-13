import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import type { LibraryTarget, useLibraryItems } from '@/hooks/useLibraryItems';

export function LibraryItemActions({ target, library, variant = 'icon' }: { target: LibraryTarget; library: ReturnType<typeof useLibraryItems>; variant?: 'icon' | 'overlay' }) {
    const { theme } = useUnistyles();
    const entry = library.stateOf(target);
    const iconColor = variant === 'overlay' ? theme.colors.imageOverlay.text : entry?.favorite ? theme.colors.textLink : theme.colors.textSecondary;
    const deleteColor = variant === 'overlay' ? entry?.state === 'deleted' ? theme.colors.imageOverlay.text : theme.colors.imageOverlay.destructive : entry?.state === 'deleted' ? theme.colors.textLink : theme.colors.textDestructive;
    const title = target.title ?? target.projectPath.split('/').pop() ?? target.projectPath;
    return <View style={{ flexDirection: 'row', gap: 4 }}>
        {entry?.state !== 'deleted' && <Button variant={variant} label={t(entry?.favorite ? 'projectGoals.unfavoriteItem' : 'projectGoals.favoriteItem', { title })} testID={`library-favorite-${target.projectPath}`} selected={entry?.favorite} onPress={() => library.favorite(target)}><Ionicons name={entry?.favorite ? 'star' : 'star-outline'} size={20} color={iconColor} /></Button>}
        <Button variant={variant} label={t(entry?.state === 'deleted' ? 'projectGoals.restoreItem' : 'projectGoals.deleteItem', { title })} testID={`library-delete-${target.projectPath}`} onPress={() => entry?.state === 'deleted' ? library.save(target, { state: 'active' }) : void library.remove(target)}><Ionicons name={entry?.state === 'deleted' ? 'arrow-undo-outline' : 'trash-outline'} size={20} color={deleteColor} /></Button>
    </View>;
}
