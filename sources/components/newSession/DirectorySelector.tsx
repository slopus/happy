import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { SearchableListSelector } from '@/components/SearchableListSelector';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';

export interface DirectorySelectorProps {
    machineHomeDir?: string | null;
    selectedPath: string;
    recentPaths: string[];
    suggestedPaths?: string[];
    favoritePaths?: string[];
    onSelect: (path: string) => void;
    onToggleFavorite?: (path: string) => void;
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;
    searchPlaceholder?: string;
    recentSectionTitle?: string;
    favoritesSectionTitle?: string;
    allSectionTitle?: string;
    noItemsMessage?: string;
}

export function DirectorySelector({
    machineHomeDir,
    selectedPath,
    recentPaths,
    suggestedPaths = [],
    favoritePaths = [],
    onSelect,
    onToggleFavorite,
    showFavorites = true,
    showRecent = true,
    showSearch = true,
    searchPlaceholder = 'Type to filter directories...',
    recentSectionTitle = 'Recent Directories',
    favoritesSectionTitle = 'Favorite Directories',
    allSectionTitle = 'All Directories',
    noItemsMessage = 'No recent directories',
}: DirectorySelectorProps) {
    const { theme } = useUnistyles();
    const homeDir = machineHomeDir || undefined;
    const recentOrSuggestedPaths = recentPaths.length > 0 ? recentPaths : suggestedPaths;
    const recentTitle = recentPaths.length > 0 ? recentSectionTitle : 'Suggested Directories';

    const allPaths = React.useMemo(() => {
        const seen = new Set<string>();
        const ordered: string[] = [];
        for (const p of [...favoritePaths, ...recentOrSuggestedPaths]) {
            if (!p) continue;
            if (seen.has(p)) continue;
            seen.add(p);
            ordered.push(p);
        }
        return ordered;
    }, [favoritePaths, recentOrSuggestedPaths]);

    return (
        <SearchableListSelector<string>
            config={{
                getItemId: (path) => path,
                getItemTitle: (path) => formatPathRelativeToHome(path, homeDir),
                getItemSubtitle: undefined,
                getItemIcon: () => (
                    <Ionicons
                        name="folder-outline"
                        size={24}
                        color={theme.colors.textSecondary}
                    />
                ),
                getRecentItemIcon: () => (
                    <Ionicons
                        name="time-outline"
                        size={24}
                        color={theme.colors.textSecondary}
                    />
                ),
                formatForDisplay: (path) => formatPathRelativeToHome(path, homeDir),
                parseFromDisplay: (text) => {
                    const trimmed = text.trim();
                    if (!trimmed) return null;
                    if (trimmed.startsWith('/')) return trimmed;
                    if (homeDir) return resolveAbsolutePath(trimmed, homeDir);
                    return null;
                },
                filterItem: (path, searchText) => {
                    const displayPath = formatPathRelativeToHome(path, homeDir);
                    return displayPath.toLowerCase().includes(searchText.toLowerCase());
                },
                searchPlaceholder,
                recentSectionTitle: recentTitle,
                favoritesSectionTitle,
                allSectionTitle,
                noItemsMessage,
                showFavorites,
                showRecent,
                showSearch,
                showAll: favoritePaths.length > 0,
                allowCustomInput: true,
            }}
            items={allPaths}
            recentItems={recentOrSuggestedPaths}
            favoriteItems={favoritePaths}
            selectedItem={selectedPath || null}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
        />
    );
}
