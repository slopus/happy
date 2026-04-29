/**
 * Project file listing via git ls-files.
 * Fetches all tracked + untracked files and stores them in Zustand.
 */

import { sessionBash } from './ops';
import { storage } from './storage';

export interface ProjectFile {
    fileName: string;
    filePath: string;
    fullPath: string;
}

export interface ProjectFilesList {
    files: ProjectFile[];
    fetchedAt: number;
}

/**
 * Fetch all project files for a session via bash.
 * Uses git ls-files (tracked + untracked), falls back to find.
 */
export async function getProjectFiles(sessionId: string): Promise<ProjectFilesList | null> {
    const session = storage.getState().sessions[sessionId];
    if (!session?.metadata?.path) {
        return null;
    }

    const cwd = session.metadata.path;

    const res = await sessionBash(sessionId, {
        command: 'git ls-files --cached --others --exclude-standard',
        cwd,
        timeout: 15000,
    });

    if (!res.success || !res.stdout) {
        return null;
    }

    const files: ProjectFile[] = res.stdout
        .split('\n')
        .filter(p => p.trim().length > 0)
        .map(p => {
            const clean = p.startsWith('./') ? p.slice(2) : p;
            const parts = clean.split('/');
            const fileName = parts[parts.length - 1] || clean;
            const filePath = parts.slice(0, -1).join('/');
            return { fileName, filePath, fullPath: clean };
        });

    return { files, fetchedAt: Date.now() };
}
