import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { GoalBoardCatalogEntry, GoalProject } from '@slopus/happy-wire';
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
/** Use actual archive prose; navigation links and frontmatter are not a project description. */
export function catalogSummary(source: string): string | undefined {
    const prose = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
        .split(/\r?\n/).map(line => line.trim()).find(line => line && !/^(?:#|[-*|>`]|\d+\.|!\[|\[)/.test(line));
    return prose?.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').slice(0, 400);
}
export async function readProjects(roots: string[]): Promise<GoalProject[]> {
    const entries = await readCatalog(roots);
    const projects = new Map<string, GoalProject>();
    for (const root of roots) {
        for (const name of (await readdir(root)).sort().slice(0, MAX_CATALOG)) {
            if (projects.size >= MAX_CATALOG) break;
            try {
                const projectPath = await safePath(root, join(root, name));
                if (!(await stat(projectPath)).isDirectory()) continue;
                const text = await readDocument(root, join(projectPath, 'index.md'));
                projects.set(projectPath, { projectPath, title: titleOf(text) || name, summary: catalogSummary(text), features: [] });
            } catch { /* Only indexed archive projects are catalogued. */ }
        }
    }
    for (const { root: _root, ...entry } of entries) {
        const projectPath = entry.projectPath!;
        const project = projects.get(projectPath) ?? { projectPath, title: entry.projectTitle!, features: [] };
        if (entry.featurePath === projectPath) project.direct = entry;
        else project.features.push(entry);
        projects.set(projectPath, project);
    }
    return [...projects.values()];
}
export async function readCatalog(roots: string[]): Promise<CatalogRecord[]> {
    const catalog: CatalogRecord[] = [];
    for (const root of roots) {
        const projects = (await readdir(root)).sort().slice(0, MAX_CATALOG);
        for (const project of projects) {
            let projectPath: string;
            try { projectPath = await safePath(root, join(root, project)); if (!(await stat(projectPath)).isDirectory()) continue; } catch { continue; }
            const projectText = await readDocument(root, join(projectPath, 'index.md')).catch(() => '');
            const projectTitle = titleOf(projectText) || project;
            const addDirect = () => {
                if (projectText && catalog.length < MAX_CATALOG && !catalog.some(entry => entry.featurePath === projectPath)) catalog.push({ root, featurePath: projectPath, projectPath, title: projectTitle, projectTitle });
            };
            // A project with no feature layer can own its tasks directly.
            try {
                const tasks = await safePath(projectPath, join(projectPath, 'tasks'));
                if ((await stat(tasks)).isDirectory() && projectText && !catalog.some(entry => entry.featurePath === projectPath)) {
                    addDirect();
                }
            } catch { /* No direct tasks. */ }
            let features: string;
            try { features = await safePath(root, join(projectPath, 'features')); } catch { addDirect(); continue; }
            let entries: string[];
            try { entries = (await readdir(features)).sort().slice(0, MAX_CATALOG); } catch { addDirect(); continue; }
            for (const feature of entries) {
                if (catalog.length >= MAX_CATALOG) return catalog;
                try {
                    const featurePath = await safePath(root, join(features, feature));
                    if (!(await stat(featurePath)).isDirectory()) continue;
                    const source = await readDocument(root, join(featurePath, 'index.md'));
                    if (catalog.some(entry => entry.featurePath === featurePath)) continue;
                    catalog.push({ root, featurePath, projectPath, title: titleOf(source) || feature, summary: catalogSummary(source), projectTitle });
                } catch { /* Not a readable feature entry. */ }
            }
            if (!catalog.some(entry => entry.projectPath === projectPath)) addDirect();
        }
    }
    return catalog;
}
