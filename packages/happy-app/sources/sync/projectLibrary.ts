import { z } from 'zod';
import type { GoalProject } from '@slopus/happy-wire';
import { accountRuntimeCurrent, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { loadProjectLibraryPreferences, saveProjectLibraryPreferences } from './persistence';

const entrySchema = z.object({ machineId: z.string(), projectPath: z.string(), favorite: z.boolean(), state: z.enum(['active', 'archived', 'deleted']) });
const preferencesSchema = z.array(entrySchema).max(10000);
export type ProjectLibraryEntry = z.infer<typeof entrySchema>;
export type ProjectLibraryFilter = 'all' | 'favorites' | 'archived' | 'deleted';
const listeners = new Set<() => void>();
let revision = 0;
export const subscribeProjectLibrary = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getProjectLibraryRevision = () => revision;
export const projectLibraryOwner = () => JSON.stringify(getRuntimeAccountSelection());

function entries(): ProjectLibraryEntry[] {
    if (!accountRuntimeCurrent()) return [];
    try { return preferencesSchema.parse(JSON.parse(loadProjectLibraryPreferences() ?? '[]')); }
    catch { return []; }
}
export function readProjectLibrary(machineId: string): Record<string, ProjectLibraryEntry> {
    return Object.fromEntries(entries().filter(entry => entry.machineId === machineId).map(entry => [entry.projectPath, entry]));
}
export function updateProjectLibrary(machineId: string, projectPath: string, patch: Partial<Pick<ProjectLibraryEntry, 'favorite' | 'state'>>, owner = projectLibraryOwner()) {
    if (!accountRuntimeCurrent() || owner !== projectLibraryOwner()) throw new Error('Account changed; reload required');
    const all = entries();
    const previous = all.find(entry => entry.machineId === machineId && entry.projectPath === projectPath);
    const next = entrySchema.parse({ machineId, projectPath, favorite: false, state: 'active', ...previous, ...patch });
    const remaining = all.filter(entry => entry.machineId !== machineId || entry.projectPath !== projectPath);
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
