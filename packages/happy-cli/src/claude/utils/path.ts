import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}

/**
 * Claude Code keys transcripts by cwd, and EnterWorktree moves a live
 * transcript to the worktree's project dir. Session ids are UUIDs, so search
 * every project dir; fall back to the expected path for a not-yet-created file.
 */
export function resolveSessionFile(workingDirectory: string, sessionId: string): string {
    const expected = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`);
    if (existsSync(expected)) {
        return expected;
    }
    const projectsRoot = dirname(dirname(expected));
    let entries: string[];
    try {
        entries = readdirSync(projectsRoot);
    } catch {
        return expected;
    }
    for (const entry of entries) {
        const candidate = join(projectsRoot, entry, `${sessionId}.jsonl`);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return expected;
}

/** Project dir holding the session's transcript, so forks land next to their source. */
export function getSessionProjectPath(workingDirectory: string, sessionId: string): string {
    return dirname(resolveSessionFile(workingDirectory, sessionId));
}
