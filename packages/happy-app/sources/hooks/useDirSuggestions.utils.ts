import { resolveAbsolutePath } from '@/utils/pathUtils';

export interface SplitPath {
    /** Parent directory as the user typed it (may still contain `~`). */
    parentDir: string;
    /** Parent directory after `~` expansion — what bash should see. */
    resolvedParentDir: string;
    /** Substring after the last `/` — used to filter `ls` results. */
    prefix: string;
}

/**
 * Splits a user-typed path into (parentDir, resolvedParentDir, prefix).
 *
 * `~/`-rooted paths are expanded against `homeDir` because bash does not expand
 * `~` inside double quotes, so the raw `ls -1ap "~/"` form would silently fail.
 *
 * Pure helper, isolated from `useDirSuggestions.ts` so it can be unit-tested
 * without dragging in React / react-native through the sync-ops import chain.
 */
export function splitPathForSuggestions(pathText: string, homeDir?: string): SplitPath {
    const lastSlash = pathText.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? pathText.slice(0, lastSlash + 1) : '/';
    const prefix = lastSlash >= 0 ? pathText.slice(lastSlash + 1) : pathText;
    const resolvedParentDir = resolveAbsolutePath(parentDir, homeDir);
    return { parentDir, resolvedParentDir, prefix };
}
