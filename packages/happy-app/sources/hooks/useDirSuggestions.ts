/**
 * Provides filesystem directory suggestions for a path input field.
 *
 * Given a machine ID and a partially-typed path, lists subdirectories under the
 * parent directory and filters them by the typed prefix. Results are debounced
 * and cached per (machineId, parentDir) pair so rapid keystrokes don't flood
 * the machine with bash calls.
 */

import * as React from 'react';
import { machineBash } from '@/sync/ops';

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

async function fetchDirs(machineId: string, dir: string): Promise<string[]> {
    const key = cacheKey(machineId, dir);
    const cached = dirCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return cached.dirs;
    }

    // List only directories (trailing slash marker from ls -p)
    const result = await machineBash(
        machineId,
        `ls -1ap "${dir}" 2>/dev/null | grep '/$' | grep -v '^\\.\\.\\?/$'`,
        dir,
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
    /** Full absolute path of the suggested directory */
    fullPath: string;
    /** Display label (just the directory name) */
    label: string;
}

/**
 * Returns directory suggestions for `pathText` typed by the user.
 *
 * Returns empty array when:
 * - `machineId` is null/undefined (machine not selected)
 * - `pathText` is empty
 * - The last path segment contains no typed characters after the final `/`
 *   AND the path already ends with `/` (to avoid suggestions on bare `/`)
 */
export function useDirSuggestions(
    machineId: string | null | undefined,
    pathText: string,
): DirSuggestion[] {
    const [suggestions, setSuggestions] = React.useState<DirSuggestion[]>([]);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestRef = React.useRef({ machineId, pathText });

    React.useEffect(() => {
        latestRef.current = { machineId, pathText };
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
            const { machineId: mid, pathText: pt } = latestRef.current;
            if (!mid || !pt) return;

            // Split into parent directory + prefix
            const lastSlash = pt.lastIndexOf('/');
            const parentDir = lastSlash >= 0 ? pt.slice(0, lastSlash + 1) : '/';
            const prefix = lastSlash >= 0 ? pt.slice(lastSlash + 1) : pt;

            // Don't suggest if there's nothing typed after the last slash
            // (avoids a suggestions list appearing on a bare path like "/home/user/")
            if (prefix.length === 0) {
                setSuggestions([]);
                return;
            }

            const dirs = await fetchDirs(mid, parentDir || '/');

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
    }, [machineId, pathText]);

    return suggestions;
}
