import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import type { LibraryTarget, useLibraryItems } from '@/hooks/useLibraryItems';

export function LibraryItemActions({ target, library }: { target: LibraryTarget; library: ReturnType<typeof useLibraryItems> }) {
    const { theme } = useUnistyles();
    const entry = library.stateOf(target);
    const title = target.title ?? target.projectPath.split('/').pop() ?? target.projectPath;
    return <View style={{ flexDirection: 'row', gap: 4 }}>
        {entry?.state !== 'deleted' && <Button touchTarget label={t(entry?.favorite ? 'projectGoals.unfavoriteItem' : 'projectGoals.favoriteItem', { title })} testID={`library-favorite-${target.projectPath}`} selected={entry?.favorite} onPress={() => library.favorite(target)}><Ionicons name={entry?.favorite ? 'star' : 'star-outline'} size={16} color={entry?.favorite ? theme.colors.textLink : theme.colors.textSecondary} /></Button>}
        <Button touchTarget label={t(entry?.state === 'deleted' ? 'projectGoals.restoreItem' : 'projectGoals.deleteItem', { title })} testID={`library-delete-${target.projectPath}`} onPress={() => entry?.state === 'deleted' ? library.save(target, { state: 'active' }) : void library.remove(target)}><Ionicons name={entry?.state === 'deleted' ? 'arrow-undo-outline' : 'trash-outline'} size={16} color={entry?.state === 'deleted' ? theme.colors.textLink : theme.colors.textDestructive} /></Button>
    </View>;
}
