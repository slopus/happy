import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { spawn as crossSpawn } from 'cross-spawn';

import { projectPath } from '../projectPath';
import { readImportedUsageRanges, type ImportedUsageRange } from './codexImportedUsage';

export interface CodexUsageTokenTotals {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
}

export interface CodexUsageDay extends CodexUsageTokenTotals {
    date: string;
    tokenCountEvents: number;
    sessions: number;
    totalOnlyTokens: number;
}

export interface CodexUsageRateLimitWindow {
    usedPercent?: number;
    windowMinutes?: number;
    resetsAt?: number;
}

export interface CodexUsageRateLimits {
    planType?: string;
    primary?: CodexUsageRateLimitWindow;
    secondary?: CodexUsageRateLimitWindow;
    rateLimitReachedType?: string | null;
}

export interface CodexUsageSnapshot {
    source: 'codex-session-jsonl';
    codexHome: string;
    sessionsDir: string;
    timeZone: string;
    scannedAt: number;
    today: CodexUsageDay | null;
    yesterday: CodexUsageDay | null;
    days: CodexUsageDay[];
    latestEvent: {
        timestamp: string;
        localDate: string;
        lastTokenUsage: CodexUsageTokenTotals;
        sessionTotalTokenUsage?: CodexUsageTokenTotals;
        rateLimits?: CodexUsageRateLimits;
        rateLimitsTimestamp?: string;
    } | null;
    warnings: string[];
}

interface CollectCodexUsageOptions {
    codexHome?: string;
    additionalCodexHomes?: string[];
    now?: Date;
    timeZone?: string;
    maxDays?: number;
    ripgrepCommands?: string[];
}

interface SessionUsageAccumulator extends CodexUsageDay {
    sessionFiles: Set<string>;
}

interface ParsedCodexUsageFile {
    filePath: string;
    events: ParsedCodexUsageEvent[];
    metadata: CodexSessionMetadata;
    latestEvent: CodexUsageSnapshot['latestEvent'];
    latestEventTime: number;
    latestRateLimits?: CodexUsageRateLimits;
    latestRateLimitsTime: number;
}

interface ParsedCodexUsageEvent {
    filePath: string;
    timestamp: string;
    eventTime: number;
    localDate: string;
    usage: CodexUsageTokenTotals;
    source: 'token-count' | 'usage-record';
    responseId?: string;
    threadId?: string;
    sessionId?: string;
    turnId?: string;
    cumulativeUsage?: CodexUsageTokenTotals;
    ordinal?: number;
}

interface CodexSessionMetadata {
    sessionId?: string;
    parentId?: string;
    forkedAt?: number;
    explicitFork?: boolean;
    hasReplayedMetadata?: boolean;
}

interface CodexUsageFileAccumulator {
    events: ParsedCodexUsageEvent[];
    metadata: CodexSessionMetadata;
    previousTotals?: CodexUsageTokenTotals;
    latestEvent: CodexUsageSnapshot['latestEvent'];
    latestEventTime: number;
    latestRateLimits?: CodexUsageRateLimits;
    latestRateLimitsTime: number;
    cumulativeMismatches?: number;
    counterResets?: number;
    incompleteReceipts?: number;
}

const localDateFormatters = new Map<string, Intl.DateTimeFormat>();

// Skip complete JSON values while locating a top-level key. Unlike a bare
// substring search, this excludes compacted histories and quoted tool output;
// unlike a fixed prefix, it does not require timestamp/type/payload key order.
const jsonValuePattern = String.raw`(?(DEFINE)(?<js>"(?:[^"\\]++|\\.)*+")(?<jv>(?&js)|(?&jo)|(?&ja)|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?<jo>\{\s*(?:(?&js)\s*:\s*(?&jv)\s*(?:,\s*(?&js)\s*:\s*(?&jv)\s*)*)?\})(?<ja>\[\s*(?:(?&jv)\s*(?:,\s*(?&jv)\s*)*)?\]))`;
const jsonFieldPattern = (key: string) => String.raw`(?:(?!"${key}"\s*:)(?&js)\s*:\s*(?&jv)\s*,\s*)*"${key}"\s*:\s*`;
const nativeUsageRecordPattern = `^\\s*\\{\\s*${jsonFieldPattern('type')}"(?:token_usage_record|session_meta)"`;
const legacyUsageRecordPattern = `^\\s*\\{\\s*(?=${jsonFieldPattern('type')}"event_msg")${jsonFieldPattern('payload')}\\{\\s*${jsonFieldPattern('type')}"token_count"`;
const usageRecordPattern = `${jsonValuePattern}(?:${nativeUsageRecordPattern}|${legacyUsageRecordPattern})`;
const sessionMetaRecordPattern = `${jsonValuePattern}^\\s*\\{\\s*${jsonFieldPattern('type')}"session_meta"`;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function tokenTotalsFromJson(usage: unknown): CodexUsageTokenTotals | null {
    if (!isRecord(usage)) {
        return null;
    }
    return {
        inputTokens: numberField(usage, 'input_tokens') || 0,
        cachedInputTokens: numberField(usage, 'cached_input_tokens') || 0,
        outputTokens: numberField(usage, 'output_tokens') || 0,
        reasoningOutputTokens: numberField(usage, 'reasoning_output_tokens') || 0,
        totalTokens: numberField(usage, 'total_tokens') || 0,
    };
}

function emptyUsageDay(date: string): SessionUsageAccumulator {
    return {
        date,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        tokenCountEvents: 0,
        sessions: 0,
        totalOnlyTokens: 0,
        sessionFiles: new Set<string>(),
    };
}

function localDateKey(date: Date, timeZone: string): string {
    let formatter = localDateFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        localDateFormatters.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function getTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

async function walkJsonlFiles(directory: string, warnings: string[]): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
        if (code !== 'ENOENT') {
            warnings.push(`Failed to read ${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walkJsonlFiles(fullPath, warnings));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push(fullPath);
        }
    }
    return files;
}

function recentLocalDateKeys(now: Date, timeZone: string, maxDays: number): string[] {
    const today = new Date(`${localDateKey(now, timeZone)}T12:00:00.000Z`);
    return Array.from({ length: maxDays }, (_, index) => {
        const date = new Date(today);
        date.setUTCDate(today.getUTCDate() - (maxDays - index - 1));
        return date.toISOString().slice(0, 10);
    });
}

async function listRecentCodexSessionFiles(
    codexHome: string,
    sessionsDir: string,
    dateKeys: string[],
    warnings: string[],
): Promise<string[]> {
    const sessionFiles = (await Promise.all(dateKeys.map((dateKey) => {
        const [year, month, day] = dateKey.split('-');
        return walkJsonlFiles(join(sessionsDir, year, month, day), warnings);
    }))).flat();
    const archivedFiles = await walkJsonlFiles(join(codexHome, 'archived_sessions'), warnings);
    const firstDate = dateKeys[0];
    const lastDate = dateKeys[dateKeys.length - 1]!;
    const recentArchivedFiles = archivedFiles.filter((filePath) => {
        const match = basename(filePath).match(/\d{4}-\d{2}-\d{2}/);
        return !match || (match[0] >= firstDate && match[0] <= lastDate);
    });

    const filesByName = new Map<string, string>();
    for (const filePath of [...sessionFiles, ...recentArchivedFiles]) {
        const name = basename(filePath);
        if (!filesByName.has(name)) {
            filesByName.set(name, filePath);
        }
    }
    return [...filesByName.values()];
}

function sessionMetadataFromRecord(record: Record<string, unknown>): CodexSessionMetadata | null {
    if (record.type !== 'session_meta' || !isRecord(record.payload)) {
        return null;
    }
    const source = isRecord(record.payload.source) ? record.payload.source : undefined;
    const subagent = source && isRecord(source.subagent) ? source.subagent : undefined;
    const threadSpawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : undefined;
    const parentId = typeof record.payload.forked_from_id === 'string'
        ? record.payload.forked_from_id
        : typeof threadSpawn?.parent_thread_id === 'string'
            ? threadSpawn.parent_thread_id
            : undefined;
    const forkedAt = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
    return {
        sessionId: typeof record.payload.id === 'string' ? record.payload.id : undefined,
        parentId: parentId || undefined,
        forkedAt: Number.isFinite(forkedAt) ? forkedAt : undefined,
        explicitFork: typeof record.payload.forked_from_id === 'string',
    };
}

async function readCodexSessionMetadata(filePath: string): Promise<CodexSessionMetadata> {
    try {
        const lines = createInterface({
            input: createReadStream(filePath, { encoding: 'utf8' }),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            try {
                const record: unknown = JSON.parse(line);
                return isRecord(record) ? sessionMetadataFromRecord(record) || {} : {};
            } catch {
                return {};
            }
        }
    } catch {
        return {};
    }
    return {};
}

async function readCodexSessionMetadataWithRipgrep(
    files: string[],
    commands = defaultRipgrepCommands(),
): Promise<Map<string, CodexSessionMetadata> | null> {
    const args = [
        '--null',
        '--with-filename',
        '--no-line-number',
        '--max-count',
        '1',
        '--pcre2',
        sessionMetaRecordPattern,
        ...files,
    ];
    for (const command of commands) {
        const child = crossSpawn(command, args, {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        const exitPromise = new Promise<{ code: number; error?: Error }>((resolveExit) => {
            child.once('error', (error) => resolveExit({ code: 1, error }));
            child.once('close', (code) => resolveExit({ code: code ?? 1 }));
        });
        const metadataByFile = new Map<string, CodexSessionMetadata>();
        try {
            const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
            for await (const line of lines) {
                const separator = line.indexOf('\0');
                if (separator < 0) {
                    continue;
                }
                try {
                    const record: unknown = JSON.parse(line.slice(separator + 1));
                    if (isRecord(record)) {
                        metadataByFile.set(line.slice(0, separator), sessionMetadataFromRecord(record) || {});
                    }
                } catch {
                    // Ignore malformed session metadata and let it behave as a root session.
                }
            }
            const result = await exitPromise;
            if (result.error) {
                throw result.error;
            }
            if (result.code <= 1) {
                return metadataByFile;
            }
        } catch {
            // Try the packaged binary, then fall back to opening the first line.
        }
    }
    return null;
}

async function expandCodexFilesWithReplayParents(
    codexHomes: string[],
    recentFiles: string[],
    firstDateKey: string,
    warnings: string[],
    ripgrepCommands?: string[],
): Promise<string[]> {
    const allFilesByName = new Map<string, string>();
    for (const home of codexHomes) {
        const active = await walkJsonlFiles(join(home, 'sessions'), warnings);
        const archived = await walkJsonlFiles(join(home, 'archived_sessions'), warnings);
        for (const filePath of [...active, ...archived]) {
            // Keep differing copies across homes for event-level deduplication.
            const key = join(home, basename(filePath));
            if (!allFilesByName.has(key)) allFilesByName.set(key, filePath);
        }
    }
    const allFiles = [...allFilesByName.values()];
    const metadataByFile = await readCodexSessionMetadataWithRipgrep(allFiles, ripgrepCommands)
        || new Map<string, CodexSessionMetadata>();
    if (metadataByFile.size === 0 && allFiles.length > 0) {
        let nextIndex = 0;
        const workerCount = Math.min(16, allFiles.length);
        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (nextIndex < allFiles.length) {
                const filePath = allFiles[nextIndex++];
                metadataByFile.set(filePath, await readCodexSessionMetadata(filePath));
            }
        }));
    }

    const filesBySessionId = new Map<string, string[]>();
    for (const filePath of allFiles) {
        const sessionId = metadataByFile.get(filePath)?.sessionId;
        if (sessionId) {
            filesBySessionId.set(sessionId, [...(filesBySessionId.get(sessionId) || []), filePath]);
        }
    }

    const selected = new Set(recentFiles);
    const minimumModifiedTime = Date.parse(`${firstDateKey}T00:00:00.000Z`) - 24 * 60 * 60 * 1000;
    await Promise.all(allFiles.map(async (filePath) => {
        try {
            if ((await stat(filePath)).mtimeMs >= minimumModifiedTime) {
                selected.add(filePath);
            }
        } catch {
            // Files can disappear while Codex archives a session; skip them.
        }
    }));
    const pending = [...selected];
    while (pending.length > 0) {
        const child = pending.pop()!;
        const parentId = metadataByFile.get(child)?.parentId;
        const parents = parentId ? filesBySessionId.get(parentId) || [] : [];
        for (const parent of parents) {
            if (parent !== child && !selected.has(parent)) {
                selected.add(parent);
                pending.push(parent);
            }
        }
    }
    return [...selected];
}

async function parseCodexUsageFile(
    filePath: string,
    timeZone: string,
    warnings: string[],
    importedRanges: ImportedUsageRange[] = [],
): Promise<ParsedCodexUsageFile | null> {
    const accumulator: CodexUsageFileAccumulator = {
        events: [],
        metadata: {},
        latestEvent: null,
        latestEventTime: 0,
        latestRateLimitsTime: 0,
    };
    try {
        const lines = createInterface({
            input: createReadStream(filePath, { encoding: 'utf8' }),
            crlfDelay: Infinity,
        });
        let lineNumber = 0;
        for await (const line of lines) {
            const imported = importedRanges.some(([start, end]) => lineNumber >= start && lineNumber < end);
            addCodexUsageLine(accumulator, line, filePath, timeZone, imported);
            lineNumber++;
        }
        // The imported prefix was removed exactly; fork replay heuristics must
        // not discard the new account's first real turns a second time.
        if (importedRanges.some(([start]) => start === 0)) accumulator.metadata.parentId = undefined;
        appendUsageDiagnostics(accumulator, warnings);
    } catch (error) {
        warnings.push(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }

    return {
        filePath,
        events: accumulator.events,
        metadata: accumulator.metadata,
        latestEvent: accumulator.latestEvent && accumulator.latestRateLimits
            ? {
                ...accumulator.latestEvent,
                rateLimits: accumulator.latestRateLimits,
                rateLimitsTimestamp: new Date(accumulator.latestRateLimitsTime).toISOString(),
            }
            : accumulator.latestEvent,
        latestEventTime: accumulator.latestEventTime,
        latestRateLimits: accumulator.latestRateLimits,
        latestRateLimitsTime: accumulator.latestRateLimitsTime,
    };
}

function usageEquals(left: CodexUsageTokenTotals | undefined, right: CodexUsageTokenTotals): boolean {
    return !!left
        && left.inputTokens === right.inputTokens
        && left.cachedInputTokens === right.cachedInputTokens
        && left.outputTokens === right.outputTokens
        && left.reasoningOutputTokens === right.reasoningOutputTokens
        && left.totalTokens === right.totalTokens;
}

function subtractUsage(current: CodexUsageTokenTotals, previous?: CodexUsageTokenTotals): CodexUsageTokenTotals {
    return {
        inputTokens: Math.max(0, current.inputTokens - (previous?.inputTokens || 0)),
        cachedInputTokens: Math.max(0, current.cachedInputTokens - (previous?.cachedInputTokens || 0)),
        outputTokens: Math.max(0, current.outputTokens - (previous?.outputTokens || 0)),
        reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - (previous?.reasoningOutputTokens || 0)),
        totalTokens: Math.max(0, current.totalTokens - (previous?.totalTokens || 0)),
    };
}

function hasUsage(usage: CodexUsageTokenTotals): boolean {
    return usage.inputTokens > 0
        || usage.cachedInputTokens > 0
        || usage.outputTokens > 0
        || usage.reasoningOutputTokens > 0;
}

function appendUsageDiagnostics(accumulator: CodexUsageFileAccumulator, warnings: string[]): void {
    if (accumulator.cumulativeMismatches) {
        warnings.push(`Codex cumulative usage differs from individual usage for ${accumulator.cumulativeMismatches} event(s); individual usage was retained and the total may be incomplete.`);
    }
    if (accumulator.counterResets) {
        warnings.push(`Codex cumulative counters decreased for ${accumulator.counterResets} event(s); individual usage was used after the reset.`);
    }
    if (accumulator.incompleteReceipts) {
        warnings.push(`Incomplete Codex usage receipts ignored for ${accumulator.incompleteReceipts} event(s); missing fields were not treated as zero.`);
    }
}

function addCodexUsageLine(
    accumulator: CodexUsageFileAccumulator,
    line: string,
    filePath: string,
    timeZone: string,
    imported = false,
): void {
    if (!line.includes('token_count') && !line.includes('token_usage_record') && !line.includes('session_meta')) {
        return;
    }

    let record: unknown;
    try {
        record = JSON.parse(line);
    } catch {
        return;
    }
    if (!isRecord(record)) {
        return;
    }

    const metadata = sessionMetadataFromRecord(record);
    if (metadata) {
        if (!accumulator.metadata.sessionId) {
            accumulator.metadata = metadata;
        } else if (metadata.sessionId === accumulator.metadata.parentId) {
            accumulator.metadata.hasReplayedMetadata = true;
        }
        return;
    }

    if (!isRecord(record.payload)) {
        return;
    }
    const payload = record.payload;
    const isTokenCount = record.type === 'event_msg' && payload.type === 'token_count';
    // A compacted record is a retained context snapshot, not a new usage event.
    // Its independent token_usage_record (when present) accounts for the request.
    const receipt = record.type === 'token_usage_record' ? payload : undefined;
    if (!isTokenCount && !receipt) return;

    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (!timestamp) {
        return;
    }

    const date = new Date(timestamp);
    const eventTime = date.getTime();
    if (!Number.isFinite(eventTime)) {
        return;
    }

    const info = isRecord(payload.info) ? payload.info : {};
    if (receipt && (!isRecord(receipt.usage)
        || !['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
            .every(key => numberField(receipt.usage as Record<string, unknown>, key) !== undefined))) {
        if (!imported) accumulator.incompleteReceipts = (accumulator.incompleteReceipts || 0) + 1;
        return;
    }
    const lastTokenUsage = tokenTotalsFromJson(receipt ? receipt.usage : info.last_token_usage);
    const sessionTotalTokenUsage = tokenTotalsFromJson(receipt ? receipt.thread_token_usage : info.total_token_usage);
    if (!lastTokenUsage && !sessionTotalTokenUsage) {
        return;
    }

    if (imported) {
        if (sessionTotalTokenUsage) accumulator.previousTotals = sessionTotalTokenUsage;
        return;
    }
    const dateKey = localDateKey(date, timeZone);
    const rateLimits = isTokenCount ? toRateLimits(payload.rate_limits) : undefined;
    if (hasUsableRateLimits(rateLimits) && eventTime > accumulator.latestRateLimitsTime) {
        accumulator.latestRateLimits = rateLimits;
        accumulator.latestRateLimitsTime = eventTime;
    }
    if (eventTime > accumulator.latestEventTime) {
        accumulator.latestEventTime = eventTime;
        accumulator.latestEvent = {
            timestamp,
            localDate: dateKey,
            lastTokenUsage: lastTokenUsage || subtractUsage(sessionTotalTokenUsage!, accumulator.previousTotals),
            sessionTotalTokenUsage: sessionTotalTokenUsage || undefined,
            rateLimits: hasUsableRateLimits(rateLimits) ? rateLimits : accumulator.latestRateLimits,
            rateLimitsTimestamp: hasUsableRateLimits(rateLimits)
                ? timestamp
                : accumulator.latestRateLimitsTime > 0
                    ? new Date(accumulator.latestRateLimitsTime).toISOString()
                    : undefined,
        };
    }

    const previousTotals = accumulator.previousTotals;
    const cumulativeAdvanced = !sessionTotalTokenUsage || !usageEquals(previousTotals, sessionTotalTokenUsage);
    const usage = receipt !== undefined || cumulativeAdvanced
        ? lastTokenUsage || (sessionTotalTokenUsage ? subtractUsage(sessionTotalTokenUsage, accumulator.previousTotals) : null)
        : null;
    if (isTokenCount && sessionTotalTokenUsage && previousTotals && cumulativeAdvanced && lastTokenUsage) {
        const decreased = Object.keys(previousTotals).some(key => (
            sessionTotalTokenUsage[key as keyof CodexUsageTokenTotals] < previousTotals[key as keyof CodexUsageTokenTotals]
        ));
        if (decreased) accumulator.counterResets = (accumulator.counterResets || 0) + 1;
        else if (!usageEquals(subtractUsage(sessionTotalTokenUsage, previousTotals), lastTokenUsage)) {
            accumulator.cumulativeMismatches = (accumulator.cumulativeMismatches || 0) + 1;
        }
    }
    // Keep the legacy stream's baseline independent: a receipt and token_count
    // frequently describe the same response and are reconciled by identity below.
    if (isTokenCount && sessionTotalTokenUsage) {
        accumulator.previousTotals = sessionTotalTokenUsage;
    }
    const responseId = stringField(receipt || info, 'response_id') || stringField(payload, 'response_id');
    if (!usage || (!hasUsage(usage) && !(receipt && responseId))) {
        return;
    }

    accumulator.events.push({
        filePath,
        timestamp,
        eventTime,
        localDate: dateKey,
        usage,
        source: receipt ? 'usage-record' : 'token-count',
        responseId,
        threadId: stringField(receipt || info, 'thread_id') || stringField(payload, 'thread_id'),
        sessionId: stringField(receipt || info, 'session_id'),
        turnId: stringField(receipt || info, 'turn_id') || stringField(payload, 'turn_id'),
        cumulativeUsage: sessionTotalTokenUsage || undefined,
        ordinal: numberField(record, 'ordinal'),
    });
}

async function parseCodexUsageFilesWithRipgrep(
    files: string[],
    timeZone: string,
    warnings: string[],
    commands = defaultRipgrepCommands(),
    boundaries = new Map<string, ImportedUsageRange[]>(),
): Promise<ParsedCodexUsageFile[] | null> {
    const args = [
        '--null',
        '--with-filename',
        '--line-number',
        '--pcre2',
        // Searching a bare word streams compacted histories and bodies into Node.
        '-e',
        usageRecordPattern,
        ...files,
    ];
    const failures: string[] = [];

    for (const command of commands) {
        const child = crossSpawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const exitPromise = new Promise<{ code: number; error?: Error }>((resolveExit) => {
            child.once('error', (error) => resolveExit({ code: 1, error }));
            child.once('close', (code) => resolveExit({ code: code ?? 1 }));
        });
        const accumulators = new Map<string, CodexUsageFileAccumulator>();
        let stderr = '';
        child.stderr.on('data', (data) => {
            if (stderr.length < 4000) {
                stderr += data.toString();
            }
        });

        try {
            const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
            for await (const line of lines) {
                const separator = line.indexOf('\0');
                if (separator < 0) {
                    continue;
                }
                const filePath = line.slice(0, separator);
                const accumulator = accumulators.get(filePath) || {
                    events: [],
                    metadata: {},
                    latestEvent: null,
                    latestEventTime: 0,
                    latestRateLimitsTime: 0,
                };
                const numbered = line.slice(separator + 1);
                const colon = numbered.indexOf(':');
                const lineNumber = Number(numbered.slice(0, colon)) - 1;
                if (colon < 1 || !Number.isSafeInteger(lineNumber) || lineNumber < 0) throw new Error('Invalid ripgrep line number');
                const imported = boundaries.get(filePath)?.some(([start, end]) => lineNumber >= start && lineNumber < end);
                addCodexUsageLine(accumulator, numbered.slice(colon + 1), filePath, timeZone, imported);
                accumulators.set(filePath, accumulator);
            }
            const result = await exitPromise;
            if (result.error) {
                throw result.error;
            }
            if (result.code <= 1) {
                return [...accumulators.entries()].map(([filePath, accumulator]) => {
                    appendUsageDiagnostics(accumulator, warnings);
                    return {
                        filePath,
                        events: accumulator.events,
                        metadata: boundaries.get(filePath)?.some(([start]) => start === 0) ? { ...accumulator.metadata, parentId: undefined } : accumulator.metadata,
                        latestEvent: accumulator.latestEvent && accumulator.latestRateLimits
                            ? {
                                ...accumulator.latestEvent,
                                rateLimits: accumulator.latestRateLimits,
                                rateLimitsTimestamp: new Date(accumulator.latestRateLimitsTime).toISOString(),
                            }
                            : accumulator.latestEvent,
                        latestEventTime: accumulator.latestEventTime,
                        latestRateLimits: accumulator.latestRateLimits,
                        latestRateLimitsTime: accumulator.latestRateLimitsTime,
                    };
                });
            }
            failures.push(`${command} exited ${result.code}: ${stderr.trim()}`);
        } catch (error) {
            failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    warnings.push(`Ripgrep Codex usage scan unavailable: ${failures.join(' | ')}`);
    return null;
}

function usageFingerprint(event: ParsedCodexUsageEvent): string {
    const usage = event.usage;
    return [
        event.timestamp,
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.outputTokens,
        usage.reasoningOutputTokens,
        usage.totalTokens,
    ].join('\0');
}

function usageValueFingerprint(event: ParsedCodexUsageEvent): string {
    const usage = event.usage;
    return [
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.outputTokens,
        usage.reasoningOutputTokens,
        usage.totalTokens,
    ].join('\0');
}

function replayFilteredEvents(
    parsedFile: ParsedCodexUsageFile,
    filesBySessionId: Map<string, ParsedCodexUsageFile>,
): ParsedCodexUsageEvent[] {
    const parentId = parsedFile.metadata.parentId;
    if (!parentId || parentId === parsedFile.metadata.sessionId
        || (!parsedFile.metadata.explicitFork && !parsedFile.metadata.hasReplayedMetadata)) {
        return parsedFile.events;
    }

    const parent = filesBySessionId.get(parentId);
    const parentPrefix = parent
        ? parent.events.filter(event => parsedFile.metadata.forkedAt === undefined || event.eventTime <= parsedFile.metadata.forkedAt)
        : [];
    let matched = 0;
    let replayDone = false;
    const filtered: ParsedCodexUsageEvent[] = [];

    for (let index = 0; index < parsedFile.events.length; index += 1) {
        const event = parsedFile.events[index];
        // A new response whose native thread is this child is not inherited
        // history, even if its token counts happen to equal a parent's request.
        if (event.source === 'usage-record' && event.responseId
            && event.threadId === parsedFile.metadata.sessionId) {
            replayDone = true;
        }
        if (replayDone) {
            filtered.push(event);
            continue;
        }
        const parentEvent = parentPrefix[matched];
        if (parentEvent && usageValueFingerprint(parentEvent) === usageValueFingerprint(event)) {
            matched += 1;
            continue;
        }

        replayDone = true;
        filtered.push(event);
    }
    return filtered;
}

function usageScope(file: ParsedCodexUsageFile): string {
    // A path is not a session identity. Copies in separate homes retain the
    // rollout basename; unrelated sessions must never share a global value key.
    return file.metadata.sessionId || basename(file.filePath);
}

function receiptIdentity(event: ParsedCodexUsageEvent, file: ParsedCodexUsageFile): string {
    return [event.threadId || file.metadata.sessionId || event.sessionId || basename(file.filePath),
        event.responseId || usageFingerprint(event)].join('\0');
}

function receiptAliases(event: ParsedCodexUsageEvent, file: ParsedCodexUsageFile): string[] {
    const scope = usageScope(file);
    if (event.source === 'token-count' && event.responseId) return [`${scope}\0response\0${event.responseId}`];
    const keys = [`${scope}\0time\0${usageFingerprint(event)}`];
    if (event.responseId) keys.push(`${scope}\0response\0${event.responseId}`);
    if (event.cumulativeUsage) {
        keys.push(`${scope}\0cumulative\0${usageValueFingerprint({ ...event, usage: event.cumulativeUsage })}\0${usageValueFingerprint(event)}`);
    }
    return keys;
}

function reconcileUsageReceipts(parsedFiles: ParsedCodexUsageFile[], warnings: string[]): ParsedCodexUsageFile[] {
    const receipts = new Map<string, {
        event: ParsedCodexUsageEvent;
        file: ParsedCodexUsageFile;
        first: ParsedCodexUsageEvent;
        values: Set<string>;
    }>();
    const aliases = new Map<string, Set<string>>();
    for (const file of parsedFiles) {
        for (const event of file.events) {
            if (event.source !== 'usage-record') continue;
            const identity = receiptIdentity(event, file);
            for (const key of receiptAliases(event, file)) {
                const identities = aliases.get(key) || new Set<string>();
                identities.add(identity);
                aliases.set(key, identities);
            }
            const existing = receipts.get(identity);
            if (!existing) {
                receipts.set(identity, { event, file, first: event, values: new Set([usageValueFingerprint(event)]) });
                continue;
            }
            existing.values.add(usageValueFingerprint(event));
            if (event.eventTime < existing.first.eventTime) existing.first = event;
            const identical = usageEquals(event.usage, existing.event.usage);
            const belongsToThread = file.metadata.sessionId === event.threadId;
            const existingBelongsToThread = existing.file.metadata.sessionId === existing.event.threadId;
            // A later receipt can correct a response. Replace its amount instead
            // of charging a second request, while keeping the original date.
            const newerRevision = event.ordinal !== undefined && existing.event.ordinal !== undefined
                ? event.ordinal > existing.event.ordinal
                : event.eventTime >= existing.event.eventTime;
            if ((!identical && newerRevision)
                || (identical && ((belongsToThread && !existingBelongsToThread)
                    || (belongsToThread === existingBelongsToThread && event.eventTime < existing.event.eventTime)))) {
                existing.event = event;
                existing.file = file;
            }
        }
    }
    const revisions = [...receipts.values()].filter(receipt => receipt.values.size > 1).length;
    if (revisions) warnings.push(`Codex usage receipts revised ${revisions} response(s); the latest receipt replaces earlier amounts on the original receipt date.`);
    const byFile = new Map<string, ParsedCodexUsageEvent[]>();
    for (const { event, first } of receipts.values()) {
        if (!hasUsage(event.usage)) continue;
        const events = byFile.get(event.filePath) || [];
        events.push({ ...event, timestamp: first.timestamp, eventTime: first.eventTime, localDate: first.localDate });
        byFile.set(event.filePath, events);
    }
    let ambiguous = 0;
    const reconciled = parsedFiles.map(file => {
        const receiptIndexes = new Map<string, number>();
        file.events.forEach((event, index) => {
            if (event.source !== 'usage-record') return;
            const id = receiptIdentity(event, file);
            if (!receiptIndexes.has(id)) receiptIndexes.set(id, index);
        });
        const usedReceipts = new Set<string>();
        let lastMatchedIndex = -1;
        let counterOffset: CodexUsageTokenTotals | undefined;
        const legacy = file.events.filter((event, eventIndex) => {
            if (event.source !== 'token-count') return false;
            const matches = receiptAliases(event, file).map(key => new Set([...(aliases.get(key) || [])].filter(id => {
                const receipt = receipts.get(id)!.event;
                return !(event.responseId && receipt.responseId && event.responseId !== receipt.responseId)
                    && !(event.turnId && receipt.turnId && event.turnId !== receipt.turnId)
                    && !(event.threadId && receipt.threadId && event.threadId !== receipt.threadId);
            }))).filter(ids => ids.size);
            const identity = matches.find(ids => ids!.size === 1)?.values().next().value;
            let pairedIndex = identity === undefined ? -1 : receiptIndexes.get(identity) ?? -1;
            if (pairedIndex < 0 && counterOffset && event.cumulativeUsage) {
                // Some native versions omit compaction from legacy counters.
                // Pair adjacent representations only when the cumulative offset
                // is fully explained by unpaired receipts since a proven pair.
                // Equal amounts or a shared turn alone do not prove a request.
                const candidates = [eventIndex - 1, eventIndex + 1].filter(index => {
                    const candidate = file.events[index];
                    if (!candidate || candidate.source !== 'usage-record' || !candidate.cumulativeUsage
                        || usedReceipts.has(receiptIdentity(candidate, file)) || !usageEquals(candidate.usage, event.usage)
                        || (candidate.responseId && event.responseId && candidate.responseId !== event.responseId)
                        || (candidate.threadId && event.threadId && candidate.threadId !== event.threadId)
                        || (candidate.turnId && event.turnId && candidate.turnId !== event.turnId)) return false;
                    if (!Object.keys(counterOffset!).every(key => candidate.cumulativeUsage![key as keyof CodexUsageTokenTotals]
                        >= event.cumulativeUsage![key as keyof CodexUsageTokenTotals])) return false;
                    const expected = { ...counterOffset! };
                    const accounted = new Set<string>();
                    for (let earlierIndex = lastMatchedIndex + 1; earlierIndex < index; earlierIndex++) {
                        const earlier = file.events[earlierIndex];
                        if (earlier.source !== 'usage-record') continue;
                        const earlierId = receiptIdentity(earlier, file);
                        if (usedReceipts.has(earlierId) || accounted.has(earlierId)) continue;
                        accounted.add(earlierId);
                        for (const key of Object.keys(expected) as Array<keyof CodexUsageTokenTotals>) expected[key] += earlier.usage[key];
                    }
                    return usageEquals(expected, subtractUsage(candidate.cumulativeUsage, event.cumulativeUsage));
                });
                if (candidates.length === 1) pairedIndex = candidates[0];
                else if (candidates.length > 1) ambiguous++;
            }
            if (identity !== undefined || pairedIndex >= 0) {
                if (pairedIndex >= 0) {
                    const paired = file.events[pairedIndex];
                    usedReceipts.add(receiptIdentity(paired, file));
                    if (event.cumulativeUsage && paired.cumulativeUsage && Object.keys(event.cumulativeUsage)
                        .every(key => paired.cumulativeUsage![key as keyof CodexUsageTokenTotals]
                            >= event.cumulativeUsage![key as keyof CodexUsageTokenTotals])) {
                        counterOffset = subtractUsage(paired.cumulativeUsage, event.cumulativeUsage);
                        lastMatchedIndex = pairedIndex;
                    } else counterOffset = undefined;
                }
                return false;
            }
            if (matches.length) ambiguous++;
            return true;
        });
        return { ...file, events: [...legacy, ...(byFile.get(file.filePath) || [])].sort((a, b) => a.eventTime - b.eventTime) };
    });
    if (ambiguous) warnings.push(`Codex usage could not uniquely associate ${ambiguous} legacy event(s) with response receipts; both were retained.`);
    return reconciled;
}

function dedupeCodexUsageEvents(parsedFiles: ParsedCodexUsageFile[], warnings: string[]): ParsedCodexUsageEvent[] {
    parsedFiles = reconcileUsageReceipts(parsedFiles, warnings);
    const filesBySessionId = new Map<string, ParsedCodexUsageFile>();
    for (const parsedFile of parsedFiles) {
        if (parsedFile.metadata.sessionId && (
            !filesBySessionId.has(parsedFile.metadata.sessionId)
            || filesBySessionId.get(parsedFile.metadata.sessionId)!.events.length < parsedFile.events.length
        )) {
            filesBySessionId.set(parsedFile.metadata.sessionId, parsedFile);
        }
    }

    const fingerprints = new Set<string>();
    const events: ParsedCodexUsageEvent[] = [];
    for (const parsedFile of parsedFiles) {
        for (const event of replayFilteredEvents(parsedFile, filesBySessionId)) {
            const fingerprint = event.source === 'usage-record'
                ? `receipt\0${receiptIdentity(event, parsedFile)}`
                : `${usageScope(parsedFile)}\0${event.responseId || usageFingerprint(event)}`;
            if (fingerprints.has(fingerprint)) {
                continue;
            }
            fingerprints.add(fingerprint);
            // A retained copy may contain newer events than the default home.
            // Count those events under the same logical session, not a second path.
            const canonicalFile = parsedFile.metadata.sessionId
                ? filesBySessionId.get(parsedFile.metadata.sessionId)?.filePath
                : undefined;
            events.push(canonicalFile ? { ...event, filePath: canonicalFile } : event);
        }
    }
    return events;
}

async function parseCodexUsageFiles(
    files: string[],
    timeZone: string,
    warnings: string[],
    ripgrepCommands?: string[],
): Promise<ParsedCodexUsageFile[]> {
    const boundaries = new Map<string, ImportedUsageRange[]>();
    for (const file of files) {
        try { boundaries.set(file, await readImportedUsageRanges(file)); }
        catch { warnings.push(`Invalid imported usage boundary: ${file}`); boundaries.set(file, [[0, Infinity]]); }
    }
    const totalBytes = (await Promise.all(files.map(async (filePath) => {
        try {
            return (await stat(filePath)).size;
        } catch {
            return 0;
        }
    }))).reduce((total, size) => total + size, 0);
    if (totalBytes >= 16 * 1024 * 1024) {
        const ripgrepResults = await parseCodexUsageFilesWithRipgrep(files, timeZone, warnings, ripgrepCommands, boundaries);
        if (ripgrepResults) {
            return ripgrepResults;
        }
    }

    const results = new Array<ParsedCodexUsageFile | null>(files.length);
    let nextIndex = 0;
    const workerCount = Math.min(2, files.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < files.length) {
            const index = nextIndex++;
            results[index] = await parseCodexUsageFile(files[index], timeZone, warnings, boundaries.get(files[index]));
        }
    }));
    return results.filter((result): result is ParsedCodexUsageFile => !!result);
}

function addUsage(day: SessionUsageAccumulator, usage: CodexUsageTokenTotals, filePath: string): void {
    day.inputTokens += usage.inputTokens;
    day.cachedInputTokens += usage.cachedInputTokens;
    day.outputTokens += usage.outputTokens;
    day.reasoningOutputTokens += usage.reasoningOutputTokens;
    day.tokenCountEvents += 1;
    day.sessionFiles.add(filePath);

    day.totalTokens += usage.totalTokens;
}

function toUsageDay(day: SessionUsageAccumulator): CodexUsageDay {
    return {
        date: day.date,
        inputTokens: day.inputTokens,
        cachedInputTokens: day.cachedInputTokens,
        outputTokens: day.outputTokens,
        reasoningOutputTokens: day.reasoningOutputTokens,
        totalTokens: day.totalTokens,
        tokenCountEvents: day.tokenCountEvents,
        sessions: day.sessionFiles.size,
        totalOnlyTokens: day.totalOnlyTokens,
    };
}

function toRateLimitWindow(value: unknown): CodexUsageRateLimitWindow | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    return {
        usedPercent: numberField(value, 'used_percent'),
        windowMinutes: numberField(value, 'window_minutes'),
        resetsAt: numberField(value, 'resets_at'),
    };
}

function toRateLimits(rateLimits: unknown): CodexUsageRateLimits | undefined {
    if (!isRecord(rateLimits)) {
        return undefined;
    }
    // Newer Codex logs interleave account quota with independent model buckets
    // (for example Spark). Those must not replace the main Codex quota, even
    // when they arrive later. Older logs omit limit_id or set it to null.
    if (rateLimits.limit_id != null && rateLimits.limit_id !== 'codex') {
        return undefined;
    }
    return {
        planType: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : undefined,
        primary: toRateLimitWindow(rateLimits.primary),
        secondary: toRateLimitWindow(rateLimits.secondary),
        rateLimitReachedType: typeof rateLimits.rate_limit_reached_type === 'string' || rateLimits.rate_limit_reached_type === null
            ? rateLimits.rate_limit_reached_type
            : undefined,
    };
}

function hasUsableRateLimits(rateLimits: CodexUsageRateLimits | undefined): rateLimits is CodexUsageRateLimits {
    return typeof rateLimits?.primary?.usedPercent === 'number'
        || typeof rateLimits?.secondary?.usedPercent === 'number';
}

function defaultRipgrepCommands(): string[] {
    const packagedBinary = join(projectPath(), 'tools', 'unpacked', process.platform === 'win32' ? 'rg.exe' : 'rg');
    return [...new Set(['rg', packagedBinary])];
}

export async function collectCodexUsageSnapshot(options: CollectCodexUsageOptions = {}): Promise<CodexUsageSnapshot> {
    const now = options.now || new Date();
    const timeZone = options.timeZone || getTimeZone();
    const codexHome = options.codexHome || process.env.CODEX_HOME || join(os.homedir(), '.codex');
    const sessionsDir = join(codexHome, 'sessions');
    const maxDays = Math.max(1, Math.floor(options.maxDays ?? 365));
    const warnings: string[] = [];
    const dateKeys = recentLocalDateKeys(now, timeZone, maxDays);
    // Parse all homes together so copied rollouts and fork replay are deduplicated
    // before daily aggregation; adding per-account daily totals would double-count.
    const homes = [...new Set([codexHome, ...(options.additionalCodexHomes || [])])];
    const recentFiles: string[] = [];
    for (const home of homes) {
        recentFiles.push(...await listRecentCodexSessionFiles(home, join(home, 'sessions'), dateKeys, warnings));
    }
    const files = await expandCodexFilesWithReplayParents(
        homes, recentFiles, dateKeys[0], warnings, options.ripgrepCommands,
    );
    const byDate = new Map<string, SessionUsageAccumulator>();
    const firstDateKey = dateKeys[0];
    const todayKey = dateKeys.at(-1)!;
    const yesterdayKey = dateKeys.at(-2) || todayKey;
    let latestEvent: CodexUsageSnapshot['latestEvent'] = null;
    let latestEventTime = 0;
    let latestRateLimits: CodexUsageRateLimits | undefined;
    let latestRateLimitsTime = 0;

    const parsedFiles = await parseCodexUsageFiles(files, timeZone, warnings, options.ripgrepCommands);
    const usageEvents = dedupeCodexUsageEvents(parsedFiles, warnings);
    for (const event of usageEvents) {
        if (event.localDate < firstDateKey || event.localDate > todayKey) {
            continue;
        }
        const day = byDate.get(event.localDate) || emptyUsageDay(event.localDate);
        addUsage(day, event.usage, event.filePath);
        byDate.set(event.localDate, day);
    }
    for (const parsedFile of parsedFiles) {
        if (parsedFile.latestRateLimits && parsedFile.latestRateLimitsTime > latestRateLimitsTime) {
            latestRateLimits = parsedFile.latestRateLimits;
            latestRateLimitsTime = parsedFile.latestRateLimitsTime;
        }
        if (
            parsedFile.latestEvent
            && parsedFile.latestEvent.localDate >= firstDateKey
            && parsedFile.latestEvent.localDate <= todayKey
            && parsedFile.latestEventTime > latestEventTime
        ) {
            latestEventTime = parsedFile.latestEventTime;
            latestEvent = parsedFile.latestEvent;
        }
    }
    if (latestEvent && latestRateLimits) {
        latestEvent = {
            ...latestEvent,
            rateLimits: latestRateLimits,
            rateLimitsTimestamp: new Date(latestRateLimitsTime).toISOString(),
        };
    }

    const days = [...byDate.values()]
        .map(toUsageDay)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-maxDays);

    return {
        source: 'codex-session-jsonl',
        codexHome,
        sessionsDir,
        timeZone,
        scannedAt: now.getTime(),
        today: days.find(day => day.date === todayKey) || null,
        yesterday: days.find(day => day.date === yesterdayKey) || null,
        days,
        latestEvent,
        warnings,
    };
}

export function mergeRecentCodexUsageSnapshot(
    previous: CodexUsageSnapshot | null | undefined,
    recent: CodexUsageSnapshot,
): CodexUsageSnapshot {
    if (
        !previous
        || previous.source !== recent.source
        || previous.codexHome !== recent.codexHome
        || previous.timeZone !== recent.timeZone
    ) {
        return recent;
    }

    const [yesterdayKey, todayKey] = recentLocalDateKeys(
        new Date(recent.scannedAt),
        recent.timeZone,
        2,
    );
    const days = [
        ...previous.days.filter((day) => day.date !== todayKey),
        ...recent.days.filter((day) => day.date === todayKey),
    ].sort((left, right) => left.date.localeCompare(right.date));
    const previousLatestTime = previous.latestEvent ? Date.parse(previous.latestEvent.timestamp) : 0;
    const recentLatestTime = recent.latestEvent ? Date.parse(recent.latestEvent.timestamp) : 0;

    return {
        ...recent,
        days,
        today: days.find((day) => day.date === todayKey) || null,
        yesterday: days.find((day) => day.date === yesterdayKey) || null,
        latestEvent: recentLatestTime >= previousLatestTime
            ? recent.latestEvent
            : previous.latestEvent,
    };
}

export function codexUsageSignature(snapshot: CodexUsageSnapshot): string {
    return JSON.stringify({
        today: snapshot.today,
        yesterday: snapshot.yesterday,
        days: snapshot.days,
        latestEvent: snapshot.latestEvent,
        warnings: snapshot.warnings,
    });
}
