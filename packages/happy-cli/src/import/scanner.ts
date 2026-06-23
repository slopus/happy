/**
 * Scanner
 *
 * Walks ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl, reads each file's
 * header, filters out:
 *   - non-UUID session IDs (agent-* and similar — Claude SDK --resume only
 *     accepts UUIDs as of v2.0.65; matches claudeFindLastSession.ts:20-21)
 *   - files that are *ancestors* in a summary/leafUuid chain (a JSONL whose
 *     leafUuid points to another JSONL means it has been resumed; we only
 *     want the resume *leaf*, since `claude --resume <leaf>` already
 *     contains the full prefixed history)
 *   - files already imported (per the journal)
 *
 * Returns a list of import candidates with everything sessionImporter
 * needs to create a happy session.
 */

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { logger } from '@/ui/logger';

import { readImportJournal } from './importJournal';
import { readJsonlHeader, type JsonlHeader } from './jsonlParser';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ImportCandidate = {
    /** Full absolute path to the JSONL file. */
    jsonlPath: string;
    /** UUID extracted from the filename — same as the session's claudeSessionId. */
    claudeSessionId: string;
    /** Project dir name as it appears under ~/.claude/projects (sanitized cwd). */
    projectDir: string;
    /** Header data for metadata + title. */
    header: JsonlHeader;
};

export type ScanOptions = {
    /** Only include sessions whose JSONL `firstCwd` starts with this directory. */
    projectFilter?: string;
    /**
     * If true, include sessions whose claudeSessionId is already in the
     * journal. Used by the rescan path that wants to refresh tail data.
     */
    includeAlreadyImported?: boolean;
    /**
     * Set of claudeSessionId values that already correspond to a happy
     * session on the server. The scanner will skip any candidate whose
     * claudeSessionId is in this set, so we don't import duplicates of
     * sessions that happy itself created.
     *
     * Caller (typically `happy import`) builds this via
     * collectHappyTrackedClaudeSessionIds(). Left empty by tests that
     * don't need this dedup path.
     */
    happyTrackedClaudeIds?: ReadonlySet<string>;
    /**
     * Only include sessions whose JSONL mtime is at or after this epoch-ms
     * timestamp. Used by `happy import --days <n>` to limit imports to recent
     * activity.
     */
    mtimeAfterMs?: number;
};

function claudeProjectsRoot(): string {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects');
}

/**
 * Scan and return all import candidates.
 *
 * Algorithm:
 *   1. List every <project>/<uuid>.jsonl under ~/.claude/projects
 *   2. Filter by UUID name shape
 *   3. Read each file's header
 *   4. Collect ancestor leafUuids from every header.summary.leafUuid
 *   5. Drop any file whose own UUID appears in the ancestor set
 *      (= it has been resumed; the resume leaf carries its history)
 *   6. Drop already-imported sessions unless includeAlreadyImported
 *
 * On any per-file error: log debug and skip. The scan as a whole never
 * throws.
 */
export async function scanForImportCandidates(opts: ScanOptions = {}): Promise<ImportCandidate[]> {
    const root = claudeProjectsRoot();

    let projectDirs: string[];
    try {
        projectDirs = await readdir(root);
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        logger.debug(`[import] failed to read ${root}: ${error?.message}`);
        return [];
    }

    type FileEntry = {
        jsonlPath: string;
        claudeSessionId: string;
        projectDir: string;
        header: JsonlHeader;
    };

    const allFiles: FileEntry[] = [];
    // claudeSessionId -> any leafUuid that points to it (i.e. this session was
    // resumed and its history was forwarded to the leaf). Anything in this set
    // is an "ancestor" and should be skipped.
    const ancestorUuids = new Set<string>();

    for (const projectDir of projectDirs) {
        const dirPath = join(root, projectDir);
        let files: string[];
        try {
            files = await readdir(dirPath);
        } catch { continue; }

        for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const claudeSessionId = file.slice(0, -'.jsonl'.length);
            if (!UUID_RE.test(claudeSessionId)) continue;

            const jsonlPath = join(dirPath, file);
            let header: JsonlHeader | null;
            try {
                header = await readJsonlHeader(jsonlPath);
            } catch (error: any) {
                logger.debug(`[import] header read failed for ${jsonlPath}: ${error?.message}`);
                continue;
            }
            if (!header) continue;

            // A summary line at the top means this JSONL was created by
            // `claude --resume <leafUuid>`. The leafUuid points to the
            // PREVIOUS session — that older session is now an ancestor and
            // should be skipped in favor of *this* file.
            if (header.summary) {
                ancestorUuids.add(header.summary.leafUuid);
            }

            allFiles.push({ jsonlPath, claudeSessionId, projectDir, header });
        }
    }

    // Drop ancestors and apply project filter / journal filter / happy-tracked filter
    const journal = opts.includeAlreadyImported ? null : await readImportJournal();

    // Sessions already represented as happy Session rows on the server
    // (passed in by the caller — typically computed via
    // collectHappyTrackedClaudeSessionIds()). Importing them again would
    // produce a duplicate.
    const happyTrackedClaudeIds = opts.includeAlreadyImported
        ? new Set<string>()
        : (opts.happyTrackedClaudeIds ?? new Set<string>());

    const candidates: ImportCandidate[] = [];
    for (const entry of allFiles) {
        if (ancestorUuids.has(entry.claudeSessionId)) continue;
        if (opts.projectFilter && entry.header.firstCwd
            && !entry.header.firstCwd.startsWith(opts.projectFilter)
        ) continue;
        if (journal && journal.imported[entry.claudeSessionId]) continue;
        if (happyTrackedClaudeIds.has(entry.claudeSessionId)) {
            logger.debug(`[import] skipping ${entry.claudeSessionId} — already a happy-spawned session`);
            continue;
        }
        if (typeof opts.mtimeAfterMs === 'number' && entry.header.mtimeMs < opts.mtimeAfterMs) {
            continue;
        }
        candidates.push(entry);
    }

    // Stable sort: newest mtime first so the user sees the most recently
    // active sessions at the top of the confirmation prompt.
    candidates.sort((a, b) => b.header.mtimeMs - a.header.mtimeMs);

    return candidates;
}
