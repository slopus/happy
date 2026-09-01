import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { spawn as crossSpawn } from 'cross-spawn';

import { projectPath } from '../projectPath';

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
}

interface CodexSessionMetadata {
    sessionId?: string;
    parentId?: string;
    forkedAt?: number;
}

interface CodexUsageFileAccumulator {
    events: ParsedCodexUsageEvent[];
    metadata: CodexSessionMetadata;
    previousTotals?: CodexUsageTokenTotals;
    latestEvent: CodexUsageSnapshot['latestEvent'];
    latestEventTime: number;
    latestRateLimits?: CodexUsageRateLimits;
    latestRateLimitsTime: number;
}

const localDateFormatters = new Map<string, Intl.DateTimeFormat>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === 'number' ? value : undefined;
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
        '--fixed-strings',
        '"type":"session_meta"',
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
    codexHome: string,
    sessionsDir: string,
    recentFiles: string[],
    firstDateKey: string,
    warnings: string[],
    ripgrepCommands?: string[],
): Promise<string[]> {
    const allActiveFiles = await walkJsonlFiles(sessionsDir, warnings);
    const allArchivedFiles = await walkJsonlFiles(join(codexHome, 'archived_sessions'), warnings);
    const allFilesByName = new Map<string, string>();
    for (const filePath of [...allActiveFiles, ...allArchivedFiles]) {
        const name = basename(filePath);
        if (!allFilesByName.has(name)) {
            allFilesByName.set(name, filePath);
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

    const filesBySessionId = new Map<string, string>();
    for (const filePath of allFiles) {
        const sessionId = metadataByFile.get(filePath)?.sessionId;
        if (sessionId && !filesBySessionId.has(sessionId)) {
            filesBySessionId.set(sessionId, filePath);
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
        const parent = parentId ? filesBySessionId.get(parentId) : undefined;
        if (parent && parent !== child && !selected.has(parent)) {
            selected.add(parent);
            pending.push(parent);
        }
    }
    return [...selected];
}

async function parseCodexUsageFile(
    filePath: string,
    timeZone: string,
    warnings: string[],
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
        for await (const line of lines) {
            addCodexUsageLine(accumulator, line, filePath, timeZone);
        }
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

function addCodexUsageLine(
    accumulator: CodexUsageFileAccumulator,
    line: string,
    filePath: string,
    timeZone: string,
): void {
    if (!line.includes('token_count') && !line.includes('session_meta')) {
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
        }
        return;
    }

    if (record.type !== 'event_msg' || !isRecord(record.payload) || record.payload.type !== 'token_count') {
        return;
    }

    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (!timestamp) {
        return;
    }

    const date = new Date(timestamp);
    const eventTime = date.getTime();
    if (!Number.isFinite(eventTime)) {
        return;
    }

    const info = isRecord(record.payload.info) ? record.payload.info : {};
    const lastTokenUsage = tokenTotalsFromJson(info.last_token_usage);
    const sessionTotalTokenUsage = tokenTotalsFromJson(info.total_token_usage);
    if (!lastTokenUsage && !sessionTotalTokenUsage) {
        return;
    }

    const dateKey = localDateKey(date, timeZone);
    const rateLimits = toRateLimits(record.payload.rate_limits);
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

    const cumulativeAdvanced = !sessionTotalTokenUsage || !usageEquals(accumulator.previousTotals, sessionTotalTokenUsage);
    const usage = cumulativeAdvanced
        ? lastTokenUsage || (sessionTotalTokenUsage ? subtractUsage(sessionTotalTokenUsage, accumulator.previousTotals) : null)
        : null;
    if (sessionTotalTokenUsage) {
        accumulator.previousTotals = sessionTotalTokenUsage;
    }
    if (!usage || !hasUsage(usage)) {
        return;
    }

    accumulator.events.push({
        filePath,
        timestamp,
        eventTime,
        localDate: dateKey,
        usage,
    });
}

async function parseCodexUsageFilesWithRipgrep(
    files: string[],
    timeZone: string,
    warnings: string[],
    commands = defaultRipgrepCommands(),
): Promise<ParsedCodexUsageFile[] | null> {
    const args = [
        '--null',
        '--with-filename',
        '--no-line-number',
        '--fixed-strings',
        '-e',
        'token_count',
        '-e',
        '"type":"session_meta"',
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
                addCodexUsageLine(accumulator, line.slice(separator + 1), filePath, timeZone);
                accumulators.set(filePath, accumulator);
            }
            const result = await exitPromise;
            if (result.error) {
                throw result.error;
            }
            if (result.code <= 1) {
                return [...accumulators.entries()].map(([filePath, accumulator]) => ({
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
                }));
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
    if (!parentId || parentId === parsedFile.metadata.sessionId) {
        return parsedFile.events;
    }

    const parent = filesBySessionId.get(parentId);
    const parentPrefix = parent
        ? parent.events.filter(event => parsedFile.metadata.forkedAt === undefined || event.eventTime <= parsedFile.metadata.forkedAt)
        : [];
    let matched = 0;
    let replayDone = false;
    let skippingRewrittenBurst = false;
    let previousSkippedTime = 0;
    const filtered: ParsedCodexUsageEvent[] = [];

    for (let index = 0; index < parsedFile.events.length; index += 1) {
        const event = parsedFile.events[index];
        if (replayDone) {
            filtered.push(event);
            continue;
        }
        if (skippingRewrittenBurst) {
            if (event.eventTime >= previousSkippedTime && event.eventTime - previousSkippedTime <= 1000) {
                previousSkippedTime = event.eventTime;
                continue;
            }
            replayDone = true;
            filtered.push(event);
            continue;
        }

        const parentEvent = parentPrefix[matched];
        if (parentEvent && usageValueFingerprint(parentEvent) === usageValueFingerprint(event)) {
            matched += 1;
            continue;
        }

        if (matched === 0) {
            const nextEvent = parsedFile.events[index + 1];
            if (nextEvent && nextEvent.eventTime >= event.eventTime && nextEvent.eventTime - event.eventTime <= 1000) {
                skippingRewrittenBurst = true;
                previousSkippedTime = event.eventTime;
                continue;
            }
        }
        replayDone = true;
        filtered.push(event);
    }
    return filtered;
}

function dedupeCodexUsageEvents(parsedFiles: ParsedCodexUsageFile[]): ParsedCodexUsageEvent[] {
    const filesBySessionId = new Map<string, ParsedCodexUsageFile>();
    for (const parsedFile of parsedFiles) {
        if (parsedFile.metadata.sessionId && !filesBySessionId.has(parsedFile.metadata.sessionId)) {
            filesBySessionId.set(parsedFile.metadata.sessionId, parsedFile);
        }
    }

    const fingerprints = new Set<string>();
    const events: ParsedCodexUsageEvent[] = [];
    for (const parsedFile of parsedFiles) {
        for (const event of replayFilteredEvents(parsedFile, filesBySessionId)) {
            const fingerprint = usageFingerprint(event);
            if (fingerprints.has(fingerprint)) {
                continue;
            }
            fingerprints.add(fingerprint);
            events.push(event);
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
    const totalBytes = (await Promise.all(files.map(async (filePath) => {
        try {
            return (await stat(filePath)).size;
        } catch {
            return 0;
        }
    }))).reduce((total, size) => total + size, 0);
    if (totalBytes >= 16 * 1024 * 1024) {
        const ripgrepResults = await parseCodexUsageFilesWithRipgrep(files, timeZone, warnings, ripgrepCommands);
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
            results[index] = await parseCodexUsageFile(files[index], timeZone, warnings);
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
    const recentFiles = await listRecentCodexSessionFiles(codexHome, sessionsDir, dateKeys, warnings);
    const files = await expandCodexFilesWithReplayParents(
        codexHome,
        sessionsDir,
        recentFiles,
        dateKeys[0],
        warnings,
        options.ripgrepCommands,
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
    const usageEvents = dedupeCodexUsageEvents(parsedFiles);
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

export function codexUsageSignature(snapshot: CodexUsageSnapshot): string {
    return JSON.stringify({
        today: snapshot.today,
        yesterday: snapshot.yesterday,
        days: snapshot.days,
        latestEvent: snapshot.latestEvent,
        warnings: snapshot.warnings,
    });
}
