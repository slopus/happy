/**
 * JSONL Parser
 *
 * Streaming reader for Claude Code's ~/.claude/projects/<dir>/<uuid>.jsonl
 * files. Each non-empty line is parsed as JSON and validated against
 * RawJSONLinesSchema. Malformed lines are skipped with a debug log instead
 * of aborting the whole file — Claude's JSONL is intentionally lenient
 * (synthetic error messages, version drift) and we want to import as much
 * as possible.
 *
 * Also provides a cheap header read for the scanner: parse only the first
 * line (the summary, if any) plus the first user message (for cwd) without
 * walking the whole file.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { RawJSONLines, RawJSONLinesSchema } from '@/claude/types';
import { logger } from '@/ui/logger';

export type JsonlHeader = {
    /** Number of bytes the JSONL occupies on disk at the moment of reading. */
    sizeBytes: number;
    /** Mtime in ms — used by the journal to detect changes since last import. */
    mtimeMs: number;
    /**
     * Summary line, if the first line is `{type:"summary",leafUuid:...}`.
     * Resume-derived JSONLs carry this; original sessions don't.
     */
    summary: { summary: string; leafUuid: string } | null;
    /**
     * The first message with a `cwd` field. Claude writes one on every line,
     * but we only need it once for happy metadata.path.
     *
     * If null, the file has no parseable user/assistant message with cwd —
     * caller should skip the file.
     */
    firstCwd: string | null;
    /** Claude session id derived from the first message line's sessionId field. */
    claudeSessionId: string | null;
    /** Truncated first user-message text suitable for a session title. */
    firstUserText: string | null;
};

/**
 * Stream a JSONL file line by line, yielding validated RawJSONLines entries.
 * Invalid lines are silently skipped (logged at debug level).
 */
export async function* iterateJsonl(
    filePath: string,
): AsyncIterable<RawJSONLines> {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let raw: unknown;
            try {
                raw = JSON.parse(trimmed);
            } catch {
                logger.debug(`[import] skipping non-JSON line in ${filePath}`);
                continue;
            }
            const parsed = RawJSONLinesSchema.safeParse(raw);
            if (!parsed.success) {
                logger.debug(`[import] skipping unrecognized JSONL row in ${filePath}: ${parsed.error.message}`);
                continue;
            }
            yield parsed.data;
        }
    } finally {
        rl.close();
        stream.close();
    }
}

/**
 * Count how many lines in the JSONL successfully validate as RawJSONLines.
 * Used to record total message count in the journal.
 */
export async function countValidLines(filePath: string): Promise<number> {
    let count = 0;
    for await (const _ of iterateJsonl(filePath)) {
        count++;
    }
    return count;
}

/**
 * Read enough of the JSONL to determine: summary (if any), cwd, sessionId,
 * first user message text. Returns null if the file has no usable header
 * (e.g. empty file or only system messages with no cwd).
 *
 * We read up to MAX_HEADER_LINES lines and stop as soon as we have both
 * cwd and sessionId — typically that's the second or third line.
 */
const MAX_HEADER_LINES = 100;

export async function readJsonlHeader(filePath: string): Promise<JsonlHeader | null> {
    let stats;
    try {
        stats = await stat(filePath);
    } catch {
        return null;
    }

    let summary: JsonlHeader['summary'] = null;
    let firstCwd: string | null = null;
    let claudeSessionId: string | null = null;
    let firstUserText: string | null = null;
    let linesSeen = 0;

    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
        for await (const line of rl) {
            linesSeen++;
            if (linesSeen > MAX_HEADER_LINES) break;
            const trimmed = line.trim();
            if (!trimmed) continue;

            let raw: any;
            try {
                raw = JSON.parse(trimmed);
            } catch { continue; }

            // Summary is always the first line if present
            if (linesSeen === 1 && raw?.type === 'summary'
                && typeof raw.summary === 'string'
                && typeof raw.leafUuid === 'string'
            ) {
                summary = { summary: raw.summary, leafUuid: raw.leafUuid };
                continue;
            }

            if (typeof raw?.cwd === 'string' && !firstCwd) {
                firstCwd = raw.cwd;
            }
            if (typeof raw?.sessionId === 'string' && !claudeSessionId) {
                claudeSessionId = raw.sessionId;
            }
            if (!firstUserText && raw?.type === 'user') {
                firstUserText = extractFirstUserText(raw);
            }

            if (firstCwd && claudeSessionId && firstUserText !== null) break;
        }
    } finally {
        rl.close();
        stream.close();
    }

    if (!firstCwd && !claudeSessionId) {
        return null;
    }

    return {
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        summary,
        firstCwd,
        claudeSessionId,
        firstUserText,
    };
}

/**
 * Best-effort extraction of the first user message text for a session title.
 * Handles both string content and block-array content with text blocks.
 * Returns null if nothing readable is present.
 */
function extractFirstUserText(raw: any): string | null {
    const content = raw?.message?.content;
    if (typeof content === 'string') {
        return truncateTitle(content);
    }
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
                return truncateTitle(block.text);
            }
        }
    }
    return null;
}

function truncateTitle(s: string): string {
    const clean = s.replace(/\s+/g, ' ').trim();
    if (clean.length <= 60) return clean;
    return clean.slice(0, 57) + '...';
}
