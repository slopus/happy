import { z } from 'zod';
import type { GoalProject } from '@slopus/happy-wire';
import { accountRuntimeCurrent, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { loadProjectLibraryPreferences, saveProjectLibraryPreferences } from './persistence';

const entrySchema = z.object({
    machineId: z.string(), projectPath: z.string(), favorite: z.boolean(), state: z.enum(['active', 'archived', 'deleted']),
    // projectPath remains the item's identity path for compatibility with v1 storage.
    kind: z.enum(['project', 'feature', 'file']).default('project'),
    title: z.string().optional(), parentProjectPath: z.string().optional(),
    scopePath: z.string().optional(), rootPath: z.string().optional(), taskId: z.string().optional(),
});
const preferencesSchema = z.array(entrySchema).max(10000);
export type ProjectLibraryEntry = z.infer<typeof entrySchema>;
export type ProjectLibraryFilter = 'all' | 'favorites' | 'archived' | 'deleted';
const listeners = new Set<() => void>();
let revision = 0;
export const subscribeProjectLibrary = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getProjectLibraryRevision = () => revision;
export const projectLibraryOwner = () => JSON.stringify(getRuntimeAccountSelection());
export type LibraryItemKind = ProjectLibraryEntry['kind'];
export const libraryItemKey = (kind: LibraryItemKind, path: string) => JSON.stringify([kind, path]);
export function readLibraryItems(machineId: string): ProjectLibraryEntry[] { return entries().filter(entry => entry.machineId === machineId); }

function entries(): ProjectLibraryEntry[] {
    if (!accountRuntimeCurrent()) return [];
    try { return preferencesSchema.parse(JSON.parse(loadProjectLibraryPreferences() ?? '[]')); }
    catch { return []; }
}
export function readProjectLibrary(machineId: string): Record<string, ProjectLibraryEntry> {
    return Object.fromEntries(readLibraryItems(machineId).filter(entry => entry.kind === 'project').map(entry => [entry.projectPath, entry]));
}
export function updateProjectLibrary(machineId: string, projectPath: string, patch: Partial<Pick<ProjectLibraryEntry, 'favorite' | 'state'>>, owner = projectLibraryOwner()) {
    updateLibraryItem(machineId, 'project', projectPath, patch, owner);
}
export function updateLibraryItem(machineId: string, kind: LibraryItemKind, projectPath: string, patch: Partial<Omit<ProjectLibraryEntry, 'machineId' | 'projectPath' | 'kind'>>, owner = projectLibraryOwner()) {
    if (!accountRuntimeCurrent() || owner !== projectLibraryOwner()) throw new Error('Account changed; reload required');
    const all = entries();
    const matches = (entry: ProjectLibraryEntry) => entry.machineId === machineId && entry.projectPath === projectPath && entry.kind === kind;
    const previous = all.find(matches);
    const next = entrySchema.parse({ favorite: false, state: 'active', ...previous, ...patch, machineId, kind, projectPath });
    const remaining = all.filter(entry => !matches(entry));
    if (next.favorite || next.state !== 'active') remaining.push(next);
    // Do not silently evict a deleted/archived project when capacity or storage is exhausted.
    saveProjectLibraryPreferences(JSON.stringify(preferencesSchema.parse(remaining)));
    revision++;
    listeners.forEach(listener => listener());
}
export function filterProjectLibrary(projects: GoalProject[], preferences: Record<string, ProjectLibraryEntry>, filter: ProjectLibraryFilter, query = '') {
    const search = query.trim().toLowerCase();
    return projects.filter(project => {
        const entry = preferences[project.projectPath];
        const state = entry?.state ?? 'active';
        const included = filter === 'favorites' ? state === 'active' && entry?.favorite : state === (filter === 'all' ? 'active' : filter);
        return included && `${project.title} ${project.summary ?? ''}`.toLowerCase().includes(search);
    });
}

/** Hidden ancestor projects/subprojects also hide their saved descendants. */
export function libraryItemAvailable(item: ProjectLibraryEntry, all: ProjectLibraryEntry[]) {
    return item.state === 'active' && !all.some(parent => parent.kind !== 'file' && parent.state !== 'active'
        && (item.projectPath.startsWith(parent.projectPath + '/') || (item.kind !== 'project' && item.projectPath === parent.projectPath && parent.kind === 'project')));
}
