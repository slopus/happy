/** Session-scoped MotionHarness review adapter; no editor code or localhost URLs cross the wire. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
    MOTION_WORKBENCH_LIMITS, MOTION_WORKBENCH_PROTOCOL,
    MotionReviewMarkerSchema, MotionWorkbenchInspectRequestSchema, MotionWorkbenchReviewRequestSchema,
    MotionWorkbenchSnapshotSchema, prepareMotionReviewPrompt,
    type MotionWorkbenchErrorCode, type MotionWorkbenchResult, type MotionWorkbenchSnapshot,
} from '@slopus/happy-wire';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { motionHarnessExecutable } from './executable';
import { createMotionProjectCatalog } from './catalog';

const execute = promisify(execFile);
const nativeSnapshotSchema = z.object({
    markers: z.array(MotionReviewMarkerSchema).max(MOTION_WORKBENCH_LIMITS.markers),
    revision: z.number().int().nonnegative().safe(),
    buildId: z.string().min(1).max(512),
    markerSnapshot: z.object({
        project: z.string().min(1).max(4096), version: z.string().min(1).max(512), complete: z.literal(true),
    }),
});
const projectConfigSchema = z.object({ version: z.literal(3), projectType: z.literal('pro') });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class MotionWorkbenchError extends Error {
    constructor(readonly code: MotionWorkbenchErrorCode, message: string) { super(message); }
}

function inside(root: string, path: string): boolean {
    const child = relative(root, path);
    return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
}

/** Canonical paths are checked before invoking an engine, including symlink escapes. */
export async function resolveMotionProject(directory: string, projectPath: string): Promise<string> {
    let root: string, project: string;
    try {
        root = await realpath(directory);
        project = await realpath(resolve(root, projectPath));
    } catch { throw new MotionWorkbenchError('PROJECT_NOT_FOUND', 'The motion project directory is unavailable.'); }
    if (!inside(root, project)) throw new MotionWorkbenchError('PROJECT_NOT_ALLOWED', 'Choose a motion project inside this session workspace.');
    let file: FileHandle | undefined;
    try {
        const configPath = join(project, 'mh.json');
        if (await realpath(configPath) !== configPath) throw new Error('Linked project configuration');
        file = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await file.stat();
        if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid project configuration');
        const bytes = Buffer.alloc(64 * 1024 + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 64 * 1024) throw new Error('Oversized project configuration');
        projectConfigSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    } catch { throw new MotionWorkbenchError('PROJECT_NOT_FOUND', 'Choose a MotionHarness Pro project with a supported mh.json.'); }
    finally { await file?.close(); }
    return project;
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    }
    return value;
}

/** Read the public CLI JSON contract; do not infer requests from document internals. */
export function normalizeMotionHarnessSnapshot(projectPath: string, input: unknown): MotionWorkbenchSnapshot {
    try {
        if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MOTION_WORKBENCH_LIMITS.snapshotBytes) throw new Error('Oversized snapshot');
        const native = nativeSnapshotSchema.parse(input);
        if (resolve(native.markerSnapshot.project) !== projectPath) throw new Error('Project mismatch');
        const content = {
            protocol: MOTION_WORKBENCH_PROTOCOL, engine: 'motionharness' as const,
            projectId: digest(JSON.stringify(['motionharness', projectPath])), projectPath,
            documentRevision: native.revision, buildId: native.buildId, markerVersion: native.markerSnapshot.version,
            markers: native.markers,
        };
        return MotionWorkbenchSnapshotSchema.parse({ ...content, snapshotHash: digest(JSON.stringify(canonical(content))) });
    } catch { throw new MotionWorkbenchError('INVALID_SNAPSHOT', 'The editor did not return a complete, versioned marker snapshot.'); }
}

async function inspectMotionProject(directory: string, projectPath: string, executable?: string): Promise<MotionWorkbenchSnapshot> {
    const project = await resolveMotionProject(directory, projectPath);
    let stdout: string;
    try {
        ({ stdout } = await execute(executable || await motionHarnessExecutable(), ['marker', 'list', '--project', project, '--output-format', 'json'], {
            cwd: project, encoding: 'utf8', timeout: 30_000, maxBuffer: MOTION_WORKBENCH_LIMITS.snapshotBytes,
            windowsHide: true, env: { ...process.env, MH_NO_BROWSER: '1', MH_NO_UPDATE_NOTIFIER: '1' },
        }));
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === 'ENOENT') throw new MotionWorkbenchError('ENGINE_UNAVAILABLE', 'Install MotionHarness on the execution machine or configure PAWS_MOTIONHARNESS_BIN.');
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new MotionWorkbenchError('INVALID_SNAPSHOT', 'The editor response exceeded the snapshot size limit.');
        if (failure.killed) throw new MotionWorkbenchError('ENGINE_TIMEOUT', 'The editor request timed out. Inspect the engine before trying again.');
        throw new MotionWorkbenchError('ENGINE_FAILURE', 'The editor request failed. No annotation was changed by Paws.');
    }
    if (await resolveMotionProject(directory, projectPath) !== project) {
        throw new MotionWorkbenchError('PROJECT_NOT_ALLOWED', 'The project binding changed during the request.');
    }
    try { return normalizeMotionHarnessSnapshot(project, JSON.parse(stdout)); }
    catch (error) {
        if (error instanceof MotionWorkbenchError) throw error;
        throw new MotionWorkbenchError('INVALID_SNAPSHOT', 'The editor response was not valid JSON.');
    }
}

/** No retries: every refresh/review is one explicit action on one session. */
export function createMotionWorkbenchHandlers(directory: string, executable?: string, catalogDirectory?: string) {
    const catalog = createMotionProjectCatalog(directory, resolveMotionProject, catalogDirectory);
    let busy = false;
    async function run<T>(work: () => Promise<T>): Promise<MotionWorkbenchResult<T>> {
        if (busy) return { ok: false, error: { code: 'BUSY', message: 'A motion-project request is already running.' } };
        busy = true;
        try { return { ok: true, value: await work() }; }
        catch (error) {
            if (error instanceof MotionWorkbenchError) return { ok: false, error: { code: error.code, message: error.message } };
            if (error instanceof z.ZodError) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid motion-project request.' } };
            return { ok: false, error: { code: 'ENGINE_FAILURE', message: 'The motion-project request could not be verified.' } };
        } finally { busy = false; }
    }
    return {
        list: (input: unknown) => run(async () => { z.object({}).strict().parse(input); return catalog.list(); }),
        register: (input: unknown) => run(async () => { const request = MotionWorkbenchInspectRequestSchema.parse(input); return catalog.register(request.projectPath); }),
        inspect: (input: unknown) => run(async () => {
            const request = MotionWorkbenchInspectRequestSchema.parse(input);
            return inspectMotionProject(directory, request.projectPath, executable);
        }),
        prepareReview: (input: unknown) => run(async () => {
            const request = MotionWorkbenchReviewRequestSchema.parse(input);
            const snapshot = await inspectMotionProject(directory, request.projectPath, executable);
            try { return { snapshot, prompt: prepareMotionReviewPrompt(snapshot, request) }; }
            catch { throw new MotionWorkbenchError('STALE_REVIEW', 'The project or selected instructions changed. Refresh before sending them to AI.'); }
        }),
    };
}

export function registerMotionWorkbenchHandlers(manager: Pick<RpcHandlerManager, 'registerHandler'>, directory: string): void {
    const handlers = createMotionWorkbenchHandlers(directory);
    manager.registerHandler('motionWorkbenchList', handlers.list);
    manager.registerHandler('motionWorkbenchRegister', handlers.register);
    manager.registerHandler('motionWorkbenchInspect', handlers.inspect);
    manager.registerHandler('motionWorkbenchPrepareReview', handlers.prepareReview);
}
