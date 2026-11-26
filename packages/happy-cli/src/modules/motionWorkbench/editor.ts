/** Optional installed-editor sidecar. Browser clients receive opaque resources, never a native URL. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
    MotionStudioOpenSchema, MotionWorkbenchRequests,
    type MotionStudioOpen, type MotionWorkbenchResult, type MotionWorkbenchErrorCode,
} from '@slopus/happy-wire';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { resolveMotionProject, MotionWorkbenchError } from './bridge';
import { createMotionProjectCatalog } from './catalog';
import { motionHarnessExecutable } from './executable';
import { buildStudioBundle, publicStudioState, readNativeResponse, NativeStudioRequestError, type NativeStudio } from './studioBundle';

const execute = promisify(execFile);
const CHUNK_BYTES = 256 * 1024;
const readRoutes = new Set(['state', 'elements', 'assets/catalog', 'exports/capabilities']);
const editRoutes = new Set(['rename', 'instance/rename', 'camera', 'audio', 'audio/config', 'time-remap', 'time-remap/stretch', 'time-remap/retime',
    'markers', 'batch', 'edit', 'settings', 'timing', 'list', 'stagger', 'table', 'sequence', 'reset', 'effects', 'geometry', 'bake',
    'undo', 'redo', 'history/seek', 'assets/replace',
    'component/action', 'component/control', 'keyframes/selection', 'keyframe/set', 'keyframe/edit', 'keyframe/remove', 'keyframe/loop',
    'layer-order', 'visibility', 'preview/ack', 'preview/capture', 'studio/preferences', 'checkpoints/create', 'checkpoints/restore']);
type Binding = {
    id: string; root: string; native: NativeStudio; bundle: Buffer; descriptor: MotionStudioOpen;
    resources: Map<string, Buffer>; sequence: number; watcher: FSWatcher; pendingChange?: ReturnType<typeof setTimeout>; busy: boolean;
};
class EditorError extends Error {
    constructor(readonly code: MotionWorkbenchErrorCode, message: string) { super(message); }
}
const assetSchema = z.object({ reference: z.object({ $asset: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(), mime: z.string().min(1).max(128), bytes: z.number().int().nonnegative().max(64 * 1024 * 1024) }).passthrough();
const stateSchema = z.object({ projectDirectory: z.string(), document: z.object({ revision: z.number().int().nonnegative(),
    instances: z.record(z.string(), z.unknown()), settings: z.record(z.string(), z.unknown()), rootInstanceId: z.string(),
}).passthrough(), schema: z.unknown(),
    buildId: z.string().min(1), generation: z.string().min(1), styles: z.array(z.string()), assets: z.array(assetSchema).max(2000) }).passthrough();

export function createMotionEditor(directory: string, options: {
    executable?: string; onChange?: (bindingId: string, sequence: number) => void; catalogDirectory?: string;
} = {}) {
    const catalog = createMotionProjectCatalog(directory, resolveMotionProject, options.catalogDirectory);
    const bindings = new Map<string, Binding>();
    let opening = false, disposed = false;
    let pendingOpen: { id: string; cancelled: boolean; done: Promise<void>; finish(): void } | undefined;
    function close(binding: Binding) {
        binding.watcher.close(); clearTimeout(binding.pendingChange); binding.resources.clear(); bindings.delete(binding.id);
        // Native sessions may also be open in the user's own Studio; never close them here.
    }
    async function bound(input: { bindingId: string }): Promise<Binding> {
        const binding = bindings.get(input.bindingId);
        if (!binding || disposed) throw new EditorError('BINDING_NOT_FOUND', 'Reopen this motion project in the current session.');
        if (await resolveMotionProject(directory, binding.root) !== binding.root) throw new EditorError('PROJECT_NOT_ALLOWED', 'The project binding changed.');
        return binding;
    }
    function publishState(binding: Binding, input: unknown): Record<string, unknown> {
        const state = stateSchema.parse(input);
        if (state.projectDirectory !== binding.root) throw new EditorError('PROJECT_NOT_ALLOWED', 'The native editor returned another project.');
        binding.native.state = state;
        binding.descriptor.state = publicStudioState(state);
        if (JSON.stringify(binding.descriptor.state).includes(binding.native.base)) throw new EditorError('INVALID_SNAPSHOT', 'Native connection data cannot cross the editor boundary.');
        binding.descriptor.assets = state.assets.map(asset => ({ id: asset.reference.$asset, mime: asset.mime, bytes: asset.bytes }));
        return binding.descriptor.state;
    }
    async function run<T>(work: () => Promise<T>): Promise<MotionWorkbenchResult<T>> {
        try { return { ok: true, value: await work() }; }
        catch (error) {
            if (error instanceof EditorError || error instanceof MotionWorkbenchError) return { ok: false, error: { code: error.code, message: error.message } };
            if (error instanceof NativeStudioRequestError && error.status === 409) return { ok: false, error: { code: 'CONFLICT', message: 'The project changed. Refresh before applying this edit.' } };
            if (error instanceof z.ZodError) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid motion editor data.' } };
            return { ok: false, error: { code: 'ENGINE_FAILURE', message: 'The installed editor could not complete this request. Reopen the project or check the execution machine.' } };
        }
    }
    return {
        open: (input: unknown) => run(async () => {
            const request = MotionWorkbenchRequests.motionWorkbenchOpen.parse(input);
            if (disposed || opening || bindings.size >= 2) throw new EditorError('BUSY', 'Close an existing motion editor before opening another.');
            const id = request.bindingId ?? randomUUID();
            if (bindings.has(id)) throw new EditorError('BUSY', 'This editor binding is already open.');
            let finish = () => {};
            const done = new Promise<void>(resolve => { finish = resolve; });
            const pending = { id, cancelled: false, done, finish }; pendingOpen = pending;
            opening = true;
            try {
                const root = await resolveMotionProject(directory, request.projectPath);
                if (pending.cancelled || disposed) throw new EditorError('BINDING_NOT_FOUND', 'Editor opening was cancelled.');
                const { stdout } = await execute(options.executable || await motionHarnessExecutable(), ['open', '--project', root, '--output-format', 'json'], {
                    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true,
                    env: { ...process.env, MH_NO_BROWSER: '1', MH_NO_UPDATE_NOTIFIER: '1' },
                });
                if (pending.cancelled || disposed) throw new EditorError('BINDING_NOT_FOUND', 'Editor opening was cancelled.');
                const opened = z.object({ sessionUrl: z.string(), directory: z.string() }).parse(JSON.parse(stdout));
                const url = new URL(opened.sessionUrl);
                if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || opened.directory !== root) throw new Error('Invalid native endpoint');
                const html = (await readNativeResponse(url.href)).bytes.toString('utf8');
                const meta = (name: string) => html.match(new RegExp(`name="${name}" content="([^"]+)"`))?.[1];
                const base = meta('mh-base'), api = meta('mh-api'), version = meta('mh-version');
                if (!base || !/^\/s\/[a-zA-Z0-9_-]+$/.test(base) || api !== base + '/api' || !version) throw new Error('Unsupported native endpoint');
                if (version !== '0.1.8') throw new EditorError('UNSUPPORTED', 'The embedded adapter currently supports MotionHarness 0.1.8.');
                const state = stateSchema.parse(JSON.parse((await readNativeResponse(url.origin + api + '/state')).bytes.toString('utf8')));
                if (state.projectDirectory !== root) throw new Error('Native project mismatch');
                const native = { origin: url.origin, base, api, version, state };
                const bundle = await buildStudioBundle(native);
                if (pending.cancelled || disposed) throw new EditorError('BINDING_NOT_FOUND', 'Editor opening was cancelled.');
                const descriptor = MotionStudioOpenSchema.parse({ bindingId: id, projectId: createHash('sha256').update(JSON.stringify(['motionharness', root])).digest('hex'),
                    projectPath: root, runtimeVersion: version, state: publicStudioState(state),
                    bundle: { bytes: bundle.bytes.length, sha256: bundle.sha256, encoding: 'gzip' },
                    assets: state.assets.map(asset => ({ id: asset.reference.$asset, mime: asset.mime, bytes: asset.bytes })),
                });
                if (JSON.stringify(descriptor).includes(base)) throw new Error('Native connection data cannot cross the editor boundary');
                await catalog.register(root, true);
                const binding: Binding = { id, root, native, bundle: bundle.bytes, descriptor, resources: new Map(), sequence: 0, busy: false,
                    watcher: watch(root, { recursive: true }, (_event, filename) => {
                        const path = filename?.toString().replaceAll('\\', '/');
                        if (path && path !== 'document.json' && path !== 'mh.json' && !path.startsWith('src/')) return;
                        if (binding.pendingChange || disposed || !bindings.has(id)) return;
                        // Coalesce one filesystem event burst; this is not a status query timer.
                        binding.pendingChange = setTimeout(() => {
                            binding.pendingChange = undefined; if (bindings.has(id)) options.onChange?.(id, ++binding.sequence);
                        }, 100);
                    }),
                };
                binding.watcher.on('error', () => options.onChange?.(id, ++binding.sequence));
                if (disposed || pending.cancelled) { binding.watcher.close(); throw new Error('Session closed'); }
                bindings.set(id, binding);
                try {
                    const latest = stateSchema.parse(JSON.parse((await readNativeResponse(native.origin + native.api + '/state')).bytes.toString('utf8')));
                    if (latest.buildId !== state.buildId || latest.generation !== state.generation) throw new EditorError('CONFLICT', 'Source changed while loading the editor. Reopen the project.');
                    publishState(binding, latest);
                    if (disposed || pending.cancelled) throw new EditorError('BINDING_NOT_FOUND', 'Editor opening was cancelled.');
                } catch (error) { close(binding); throw error; }
                return descriptor;
            } finally { opening = false; if (pendingOpen === pending) pendingOpen = undefined; pending.finish(); }
        }),
        state: (input: unknown) => run(async () => {
            const binding = await bound(MotionWorkbenchRequests.motionWorkbenchState.parse(input));
            return publishState(binding, JSON.parse((await readNativeResponse(binding.native.origin + binding.native.api + '/state')).bytes.toString('utf8')));
        }),
        resource: (input: unknown) => run(async () => {
            const request = MotionWorkbenchRequests.motionWorkbenchResource.parse(input);
            const binding = await bound(request);
            let bytes = request.resourceId === 'bundle' ? binding.bundle : binding.resources.get(request.resourceId);
            if (!bytes) {
                const id = request.resourceId.slice('asset:'.length);
                const asset = binding.descriptor.assets.find(value => value.id === id);
                if (!asset) throw new EditorError('RESOURCE_NOT_FOUND', 'This resource is not part of the bound project.');
                bytes = (await readNativeResponse(binding.native.origin + binding.native.api + '/assets/' + id, {}, 64 * 1024 * 1024)).bytes;
                if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Asset integrity failed');
                const cachedBytes = [...binding.resources.values()].reduce((total, resource) => total + resource.length, 0);
                if (cachedBytes + bytes.length > 128 * 1024 * 1024) binding.resources.clear();
                binding.resources.set(request.resourceId, bytes);
            }
            if (request.offset > bytes.length) throw new EditorError('INVALID_REQUEST', 'Resource offset is out of bounds.');
            const end = Math.min(bytes.length, request.offset + CHUNK_BYTES);
            return { offset: request.offset, totalBytes: bytes.length, dataBase64: bytes.subarray(request.offset, end).toString('base64'), done: end === bytes.length };
        }),
        operation: (input: unknown) => run(async () => {
            const request = MotionWorkbenchRequests.motionWorkbenchOperation.parse(input);
            const binding = await bound(request);
            if (JSON.stringify(request.body ?? {}).length > 4 * 1024 * 1024) throw new EditorError('INVALID_REQUEST', 'Editor operation is too large.');
            let allowed = (request.body === undefined ? readRoutes : editRoutes).has(request.route);
            if (request.body === undefined && request.route.startsWith('assets/info?')) {
                const query = new URLSearchParams(request.route.slice('assets/info?'.length));
                const hash = query.get('hash');
                allowed = !!hash && /^[a-f0-9]{64}$/.test(hash) && binding.descriptor.assets.some(asset => asset.id === hash)
                    && [...query.keys()].length === new Set(query.keys()).size
                    && [...query.keys()].every(key => ['hash', 'metadata', 'thumbnail', 'thumbnailFit'].includes(key))
                    && (!query.has('metadata') || query.get('metadata') === 'true') && (!query.has('thumbnail') || query.get('thumbnail') === 'true')
                    && (!query.has('thumbnailFit') || ['source', 'contain'].includes(query.get('thumbnailFit')!));
            }
            if (!allowed) throw new EditorError('UNSUPPORTED', 'This action is managed by Paws.');
            if (request.route === 'preview/capture') z.object({ time: z.number().finite().nonnegative(), format: z.literal('jpg'), expectedBuildId: z.string(), expectedRevision: z.number().int().nonnegative().optional() }).strict().parse(request.body);
            const editing = request.body !== undefined && !['preview/ack', 'preview/capture'].includes(request.route);
            if (editing && binding.busy) throw new EditorError('BUSY', 'An editor operation is already running.');
            if (editing) binding.busy = true;
            try {
                const response = await readNativeResponse(binding.native.origin + binding.native.api + '/' + request.route,
                    request.body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request.body, origin: 'studio' }) });
                const result = JSON.parse(response.bytes.toString('utf8')) as Record<string, unknown>;
                const visible = result.document && result.schema ? publishState(binding, result)
                    : result.state && typeof result.state === 'object' ? { ...result, state: publishState(binding, result.state) } : result;
                if (JSON.stringify(visible).includes(binding.native.base)) throw new EditorError('INVALID_SNAPSHOT', 'Native connection data cannot cross the editor boundary.');
                return visible;
            } finally { if (editing) binding.busy = false; }
        }),
        close: (input: unknown) => run(async () => {
            const request = MotionWorkbenchRequests.motionWorkbenchClose.parse(input);
            const pending = pendingOpen?.id === request.bindingId ? pendingOpen : undefined;
            if (pending) pending.cancelled = true;
            const binding = bindings.get(request.bindingId); if (binding) close(binding);
            await pending?.done;
            return { closed: true as const };
        }),
        dispose() { disposed = true; if (pendingOpen) pendingOpen.cancelled = true; for (const binding of bindings.values()) close(binding); },
    };
}

export function registerMotionEditorHandlers(manager: Pick<RpcHandlerManager, 'registerHandler'>, directory: string, options: Parameters<typeof createMotionEditor>[1]) {
    const editor = createMotionEditor(directory, options);
    manager.registerHandler('motionWorkbenchOpen', editor.open);
    manager.registerHandler('motionWorkbenchState', editor.state);
    manager.registerHandler('motionWorkbenchResource', editor.resource);
    manager.registerHandler('motionWorkbenchOperation', editor.operation);
    manager.registerHandler('motionWorkbenchClose', editor.close);
    return editor;
}
