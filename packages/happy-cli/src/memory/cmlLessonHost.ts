/**
 * Adapter onto the CML stable lesson-host entry point.
 *
 * One module is imported and one only: `dist/services/lesson-host-service.js`.
 * That file is the contract. Reaching past it into `dist/core/...` — which is
 * where the underlying functions live *in source* — resolves to nothing in the
 * built package, and an earlier version of this adapter reported every install
 * as `unsupported` for exactly that reason. Source layout is not artifact
 * layout.
 *
 * `openLessonHostService` owns opening the store, which matters: it runs the
 * event store's `initialize()`, and a database opened without that has no
 * candidate or trace tables. A store with no schema is not an empty store.
 *
 * The package is not a dependency of this CLI. It is whatever the user
 * installed, so every failure to load it — absent, unreadable, or an older
 * build without this entry point — resolves to `unsupported` rather than an
 * error. A host that cannot reach the store must say so; it must never look
 * like a store with nothing in it.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadExternalEsModule } from './externalModuleLoader';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type LessonCapability = 'lesson.read' | 'lesson.review' | 'lesson.manage';

/** The binding CML trusts. A request can neither supply nor override any field. */
export interface VerifiedLessonHostBinding {
    projectHash: string;
    actorId: string;
    userId: string;
    machineId: string;
    sessionId: string;
    generation: number;
    capabilities: readonly LessonCapability[];
}

/** Only the operations this host actually calls. */
export interface LessonHostService {
    recall(input: unknown): Promise<unknown>;
    get(input: unknown): Promise<unknown>;
    recordRead(input: unknown): Promise<unknown>;
    ackDelivery(input: unknown): Promise<unknown>;
    enqueueCandidate(input: unknown): Promise<unknown>;
    markReviewed(input: unknown): Promise<unknown>;
    approveCandidate(input: unknown): Promise<unknown>;
    rejectCandidate(input: unknown): Promise<unknown>;
    setRecallEnabled(input: unknown): Promise<unknown>;
    listCandidates(input: unknown): Promise<unknown>;
    listLessons(input: unknown): Promise<unknown>;
    reviewStatus(input: unknown): Promise<unknown>;
    /**
     * Persists this turn's redacted evidence and returns the real event ids.
     *
     * Optional on the type because an older installed build does not have it.
     * Its absence is `unsupported`, never a reason to invent ids: CML checks
     * every source ref exists and belongs to the project, so fabricated ones
     * are refused at the store — and would be a lie in the record if they were
     * not.
     */
    appendNormalEndEvidence?(input: unknown): Promise<unknown>;
}

export interface CmlLessonHostModules {
    openLessonHostService(options: {
        /** Absolute, host-resolved. CML normalizes worktrees onto one store. */
        projectPath: string;
        verifyBinding(binding: unknown): Promise<VerifiedLessonHostBinding> | VerifiedLessonHostBinding;
        isolatedStorageRoot?: string;
    }): Promise<{ projectHash: string; service: LessonHostService; close(): Promise<void> }>;
    hashLessonCandidatePayload(payload: unknown): string;
}

export type CmlLessonHostLoad =
    | { ok: true; modules: CmlLessonHostModules }
    | { ok: false; reason: 'unsupported'; detail: string };

const SERVICE_ENTRY = 'claude-memory-layer/dist/services/lesson-host-service.js';
const SERVICE_PATH = join('claude-memory-layer', 'dist', 'services', 'lesson-host-service.js');
const SERVICE_EXPORTS = ['openLessonHostService', 'hashLessonCandidatePayload'] as const;

/**
 * Finds the installed package.
 *
 * `createRequire(...).resolve()` alone is wrong here and was: CML is not a
 * dependency of this CLI, it is a **globally installed** npm package — the
 * same one the desktop detects by `command -v claude-memory-layer` and
 * `npm root -g`. Node resolution never looks there, so the previous version
 * found it only when a test pointed `CLAUDE_MEMORY_LESSON_HOST_ROOT` at a
 * checkout, and reported every real installation as `unsupported`.
 *
 * `npm root -g` is run by the daemon, with its own environment. A spawn
 * caller's `PATH` is not consulted: it controls the environment agents get,
 * and letting it name the directory a lesson store is loaded from would let it
 * substitute the package wholesale. `CLAUDE_MEMORY_NPM_BIN` exists so a test
 * can stand in a fake `npm` and exercise this resolution for real, rather than
 * skipping past it with the checkout override.
 */
export async function resolveServiceEntry(env: NodeJS.ProcessEnv): Promise<string | null> {
    const root = env.CLAUDE_MEMORY_LESSON_HOST_ROOT?.trim();
    if (root) {
        const candidate = join(root, 'dist', 'services', 'lesson-host-service.js');
        return existsSync(candidate) ? candidate : null;
    }
    // A workspace install, if anyone ever adds one as a dependency.
    try {
        return createRequire(import.meta.url).resolve(SERVICE_ENTRY);
    } catch {
        // Expected in every real deployment; the global root is next.
    }
    try {
        const { stdout } = await run(
            env.CLAUDE_MEMORY_NPM_BIN?.trim() || 'npm',
            ['root', '-g'],
            { timeout: 5_000 },
        );
        const globalRoot = stdout.split('\n')[0]?.trim();
        if (!globalRoot) return null;
        const candidate = join(globalRoot, SERVICE_PATH);
        return existsSync(candidate) ? candidate : null;
    } catch {
        return null;
    }
}

/**
 * Resolves the installed package.
 *
 * `CLAUDE_MEMORY_LESSON_HOST_ROOT` points at a built checkout and is how the
 * integration fixture exercises this path against a real artifact; without it
 * the ordinary Node resolution applies. The override is read from the daemon's
 * own environment, never from anything a spawn RPC caller supplied — the
 * caller-controlled environment is sanitized before it reaches an agent, and
 * this module runs in the daemon where that sanitization does not apply.
 */
export async function loadCmlLessonHost(
    env: NodeJS.ProcessEnv = process.env,
): Promise<CmlLessonHostLoad> {
    const entry = await resolveServiceEntry(env);
    if (!entry) return { ok: false, reason: 'unsupported', detail: 'not-installed' };
    let loaded: Record<string, unknown>;
    try {
        // `pathToFileURL`, not string concatenation: a real install path can
        // contain a space or a `#`, and both break a hand-built `file://`.
        loaded = await loadExternalEsModule(pathToFileURL(entry).href);
    } catch {
        // Classification only — a raw error quotes the resolved path.
        return { ok: false, reason: 'unsupported', detail: 'entry-unloadable' };
    }
    for (const name of SERVICE_EXPORTS) {
        if (typeof loaded[name] !== 'function') {
            // An install that has the package but not this entry point is an
            // older build. Naming the missing export is what tells a user to
            // upgrade rather than to debug an empty lesson list.
            // Names the missing export, which is what tells a user to upgrade
            // rather than to debug an empty lesson list. No path, no message.
            return { ok: false, reason: 'unsupported', detail: `missing-export:${name}` };
        }
    }
    return { ok: true, modules: loaded as unknown as CmlLessonHostModules };
}

export interface LessonHostHandle {
    service: LessonHostService;
    projectHash: string;
    /**
     * The workspace this store was opened for — the path a lesson lookup must
     * name. Not the provider's cwd: a checkpoint-protected turn runs in its own
     * repository, which CML would not resolve onto this project's store.
     */
    projectPath?: string;
    hashCandidatePayload(payload: unknown): string;
    close(): Promise<void>;
}

export type LessonHostOpen =
    | { ok: true; handle: LessonHostHandle }
    | { ok: false; reason: 'unsupported'; detail: string };

/**
 * Opens the store for one project directory.
 *
 * `workspaceDir` is passed through untouched. CML resolves a worktree onto its
 * main checkout with `git rev-parse --git-common-dir`, so normalizing it here
 * would produce a second, colder store for the same project.
 */
export async function openLessonHost(input: {
    workspaceDir: string;
    verifyBinding(binding: unknown): Promise<VerifiedLessonHostBinding> | VerifiedLessonHostBinding;
    /** Fixture-only; production uses CML's canonical project store. */
    isolatedStorageRoot?: string;
    env?: NodeJS.ProcessEnv;
    load?: typeof loadCmlLessonHost;
}): Promise<LessonHostOpen> {
    const loaded = await (input.load ?? loadCmlLessonHost)(input.env ?? process.env);
    if (!loaded.ok) return loaded;
    try {
        const opened = await loaded.modules.openLessonHostService({
            projectPath: input.workspaceDir,
            verifyBinding: input.verifyBinding,
            ...(input.isolatedStorageRoot ? { isolatedStorageRoot: input.isolatedStorageRoot } : {}),
        });
        return {
            ok: true,
            handle: {
                service: opened.service,
                projectHash: opened.projectHash,
                projectPath: input.workspaceDir,
                hashCandidatePayload: (payload) => loaded.modules.hashLessonCandidatePayload(payload),
                close: () => opened.close(),
            },
        };
    } catch {
        // A store that will not open is not an empty store. Classification
        // only: the error quotes the store path.
        return { ok: false, reason: 'unsupported', detail: 'store-unopenable' };
    }
}

/** One page of a paged CML list. `nextOffset` is null on the last page. */
export interface LessonPage {
    ok: boolean;
    /** `'ok'`, or whatever the store refused with. */
    outcome: string;
    rows: unknown[];
    nextOffset: number | null;
}

/**
 * Reads a `{ outcome, <rows>, nextOffset }` page.
 *
 * A refusal is returned as a refusal. Collapsing a non-`ok` outcome into an
 * empty page would render "no lessons yet" for a store that answered
 * `unsupported_version`, and the caller would have no way to tell the two
 * apart — so `outcome` is carried out and the caller must look at it.
 */
export function readLessonPage(raw: unknown, key: 'lessons' | 'candidates'): LessonPage {
    if (!raw || typeof raw !== 'object') return { ok: false, outcome: 'malformed', rows: [], nextOffset: null };
    const record = raw as Record<string, unknown>;
    if (record.outcome !== 'ok') {
        return {
            ok: false,
            outcome: typeof record.outcome === 'string' ? record.outcome : 'malformed',
            rows: [],
            nextOffset: null,
        };
    }
    const rows = Array.isArray(record[key]) ? record[key] as unknown[] : [];
    const next = record.nextOffset;
    return {
        ok: true,
        outcome: 'ok',
        rows,
        nextOffset: typeof next === 'number' && Number.isSafeInteger(next) && next >= 0 ? next : null,
    };
}
