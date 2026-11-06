import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { GoalBoardCatalogEntry } from '@slopus/happy-wire';
import { readDocument, titleOf } from './parser';

export const MAX_CATALOG = 100;
export function within(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}
export async function safePath(root: string, candidate: string): Promise<string> {
    if (!within(root, resolve(candidate))) throw new Error('Path escapes authorized Goal root');
    const actual = await realpath(candidate);
    if (!within(root, actual)) throw new Error('Symlink escapes authorized Goal root');
    return actual;
}

/** Only installed skill entry points and working-directory ancestors are inspected. */
export async function discoverRoots(workingDirectory: string, homeDirectory = homedir()): Promise<string[]> {
    const candidates = new Set<string>();
    for (const folder of ['.codex/skills', '.claude/skills', '.agents/skills']) candidates.add(join(homeDirectory, folder, 'goal-first-ops/projects'));
    let current = resolve(workingDirectory);
    for (let depth = 0; depth < 40; depth++) {
        if (basename(current) === 'goal-first-ops') candidates.add(join(current, 'projects'));
        // A working directory already inside a portable Goal First projects tree.
        if (basename(current) === 'projects') candidates.add(current);
        for (const folder of ['.codex/skills', '.claude/skills', '.agents/skills']) candidates.add(join(current, folder, 'goal-first-ops/projects'));
        if (dirname(current) === current) break;
        current = dirname(current);
    }
    const roots = new Set<string>();
    for (const candidate of candidates) {
        try { const actual = await realpath(candidate); if ((await stat(actual)).isDirectory()) roots.add(actual); } catch { /* Not installed here. */ }
    }
    return [...roots].sort();
}

export type CatalogRecord = GoalBoardCatalogEntry & { root: string };
export async function readCatalog(roots: string[]): Promise<CatalogRecord[]> {
    const catalog: CatalogRecord[] = [];
    for (const root of roots) {
        const projects = (await readdir(root)).sort().slice(0, MAX_CATALOG);
        for (const project of projects) {
            const projectPath = join(root, project);
            let features: string;
            try { features = await safePath(root, join(projectPath, 'features')); } catch { continue; }
            let entries: string[];
            try { entries = (await readdir(features)).sort().slice(0, MAX_CATALOG); } catch { continue; }
            const projectText = await readDocument(root, join(projectPath, 'index.md')).catch(() => '');
            for (const feature of entries) {
                if (catalog.length >= MAX_CATALOG) return catalog;
                try {
                    const featurePath = await safePath(root, join(features, feature));
                    if (!(await stat(featurePath)).isDirectory()) continue;
                    const source = await readDocument(root, join(featurePath, 'index.md'));
                    if (catalog.some(entry => entry.featurePath === featurePath)) continue;
                    catalog.push({ root, featurePath, title: titleOf(source) || feature, projectTitle: titleOf(projectText) || project });
                } catch { /* Not a readable feature entry. */ }
            }
        }
    }
    return catalog;
}
