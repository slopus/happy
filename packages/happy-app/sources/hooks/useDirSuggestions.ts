/**
 * Provides filesystem directory suggestions for a path input field.
 *
 * Given a machine ID and a partially-typed path, lists subdirectories under the
 * parent directory and filters them by the typed prefix. Results are debounced
 * and cached per (machineId, resolvedParentDir) pair so rapid keystrokes don't
 * flood the machine with bash calls.
 *
 * Paths beginning with `~` are expanded against the machine's home directory
 * before being shipped to bash — bash does not expand `~` inside double quotes,
 * so the raw `ls -1ap "~/"` form would silently fail.
 */

import * as React from 'react';
import { machineBash } from '@/sync/ops';
import { splitPathForSuggestions } from './useDirSuggestions.utils';

export { splitPathForSuggestions } from './useDirSuggestions.utils';
export type { SplitPath } from './useDirSuggestions.utils';

const DEBOUNCE_MS = 250;
const CACHE_TTL_MS = 10_000;

interface CacheEntry {
    dirs: string[];
    ts: number;
}

// Module-level cache — survives re-renders, cleared when TTL expires
const dirCache = new Map<string, CacheEntry>();

function cacheKey(machineId: string, dir: string): string {
    return `${machineId}:${dir}`;
}

async function fetchDirs(machineId: string, resolvedDir: string): Promise<string[]> {
    const key = cacheKey(machineId, resolvedDir);
    const cached = dirCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return cached.dirs;
    }

    // List only directories (trailing slash marker from ls -p)
    const result = await machineBash(
        machineId,
        `ls -1ap "${resolvedDir}" 2>/dev/null | grep '/$' | grep -v '^\\.\\.\\?/$'`,
        resolvedDir,
    );

    if (!result.success) {
        return [];
    }

    const dirs = result.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/\/$/, '')); // strip trailing slash

    dirCache.set(key, { dirs, ts: Date.now() });
    return dirs;
}

export interface DirSuggestion {
    /** Suggested directory path — preserves the user's typed parent form (keeps `~` if they typed `~`). */
    fullPath: string;
    /** Display label (just the directory name). */
    label: string;
}

/**
 * Returns directory suggestions for `pathText` typed by the user.
 *
 * Pass `homeDir` (from the selected machine's metadata) so `~/...` inputs
 * resolve to a real directory on the remote machine.
 *
 * Returns empty array when:
 * - `machineId` is null/undefined (machine not selected)
 * - `pathText` is empty
 * - The path already ends with `/` (nothing typed after the final `/`)
 */
export function useDirSuggestions(
    machineId: string | null | undefined,
    pathText: string,
    homeDir?: string,
): DirSuggestion[] {
    const [suggestions, setSuggestions] = React.useState<DirSuggestion[]>([]);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestRef = React.useRef({ machineId, pathText, homeDir });

    React.useEffect(() => {
        latestRef.current = { machineId, pathText, homeDir };
    });

    React.useEffect(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
        }

        if (!machineId || !pathText) {
            setSuggestions([]);
            return;
        }

        timerRef.current = setTimeout(async () => {
            const { machineId: mid, pathText: pt, homeDir: hd } = latestRef.current;
            if (!mid || !pt) return;

            const { parentDir, resolvedParentDir, prefix } = splitPathForSuggestions(pt, hd);

            if (prefix.length === 0) {
                setSuggestions([]);
                return;
            }

            const dirs = await fetchDirs(mid, resolvedParentDir);

            if (latestRef.current.machineId !== mid || latestRef.current.pathText !== pt) {
                return; // stale
            }

            const filtered = dirs
                .filter((d) => d.toLowerCase().startsWith(prefix.toLowerCase()))
                .map((d) => ({
                    fullPath: `${parentDir}${d}`,
                    label: d,
                }));

            setSuggestions(filtered);
        }, DEBOUNCE_MS);

        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
            }
        };
    }, [machineId, pathText, homeDir]);

    return suggestions;
}
