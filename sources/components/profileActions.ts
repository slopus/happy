import type { ItemAction } from '@/components/ItemActionsMenuModal';
import type { AIBackendProfile } from '@/sync/settings';

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
            title: 'View environment variables',
            icon: 'list-outline',
            onPress: params.onViewEnvironmentVariables,
        });
    }

    const favoriteColor = params.isFavorite ? params.favoriteActionColor : params.nonFavoriteActionColor;
    const favoriteAction: ItemAction = {
        id: 'favorite',
        title: params.isFavorite ? 'Remove from favorites' : 'Add to favorites',
        icon: params.isFavorite ? 'star' : 'star-outline',
        onPress: params.onToggleFavorite,
    };
    if (favoriteColor) {
        favoriteAction.color = favoriteColor;
    }
    actions.push(favoriteAction);

    actions.push({
        id: 'edit',
        title: 'Edit profile',
        icon: 'create-outline',
        onPress: params.onEdit,
    });

    actions.push({
        id: 'copy',
        title: 'Duplicate profile',
        icon: 'copy-outline',
        onPress: params.onDuplicate,
    });

    if (!params.profile.isBuiltIn && params.onDelete) {
        actions.push({
            id: 'delete',
            title: 'Delete profile',
            icon: 'trash-outline',
            destructive: true,
            onPress: params.onDelete,
        });
    }

    return actions;
}

