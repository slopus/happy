import type { ItemAction } from '@/components/ui/lists/itemActions';
import type { AIBackendProfile } from '@/sync/settings';
import { t } from '@/text';

export function buildProfileActions(params: {
    profile: AIBackendProfile;
    isFavorite: boolean;
    favoriteActionColor?: string;
    nonFavoriteActionColor?: string;
    onToggleFavorite: () => void;
    onEdit: () => void;
    onDuplicate: () => void;
    onDelete?: () => void;
    onViewEnvironmentVariables?: () => void;
}): ItemAction[] {
    const actions: ItemAction[] = [];

    if (params.onViewEnvironmentVariables) {
        actions.push({
            id: 'envVars',
            title: t('profiles.actions.viewEnvironmentVariables'),
            icon: 'list-outline',
            onPress: params.onViewEnvironmentVariables,
        });
    }

    const favoriteColor = params.isFavorite ? params.favoriteActionColor : params.nonFavoriteActionColor;
    const favoriteAction: ItemAction = {
        id: 'favorite',
        title: params.isFavorite ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites'),
        icon: params.isFavorite ? 'star' : 'star-outline',
        onPress: params.onToggleFavorite,
    };
    if (favoriteColor) {
        favoriteAction.color = favoriteColor;
    }
    actions.push({
        id: 'edit',
        title: t('profiles.actions.editProfile'),
        icon: 'create-outline',
        onPress: params.onEdit,
    });

    actions.push({
        id: 'copy',
        title: t('profiles.actions.duplicateProfile'),
        icon: 'copy-outline',
        onPress: params.onDuplicate,
    });

    if (!params.profile.isBuiltIn && params.onDelete) {
        actions.push({
            id: 'delete',
            title: t('profiles.actions.deleteProfile'),
            icon: 'trash-outline',
            destructive: true,
            onPress: params.onDelete,
        });
    }

    // Keep favorite as the far-right inline action (and last in compact rows too).
    actions.push(favoriteAction);

    return actions;
}
