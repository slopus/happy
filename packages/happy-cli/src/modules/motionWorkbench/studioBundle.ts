/** Build an isolated editor from the user's installed GPL runtime; never ship it in Paws sources. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { open, readFile, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import type { BuildOptions, BuildResult, Plugin } from 'esbuild';
import { studioHostEntry } from './studioHostEntry';

export type NativeStudio = { origin: string; base: string; api: string; version: string; state: Record<string, unknown> };
type Bundler = { build(options: BuildOptions): Promise<BuildResult> };
export class NativeStudioRequestError extends Error { constructor(readonly status: number) { super(`Editor request failed (${status})`); } }

const NOTICE_FILE_LIMIT = 256 * 1024;
const NOTICE_METADATA_LIMIT = 64 * 1024;
const NOTICE_TOTAL_LIMIT = 1024 * 1024;
const adapterSource = 'https://github.com/wangjs-jacky/happy/blob/main/packages/happy-cli/src/modules/motionWorkbench/';
const adapterModifications = [
    'Paws adapter changes, 2026-11-26:',
    '- Bundle an event-driven MessageChannel project host and transport for an isolated iframe.',
    '- Replace CompositionStudio view-context interval reporting with Studio and playback subscriptions.',
    '- Disable the native agent hook; Paws dispatches explicit review requests through its conversation queue.',
    '- Forward Studio failures to a Paws diagnostic event.',
    '- Disable the native export-preview feature that queries export status; Paws handles export requests.',
    '- Hide the native notes footer in the embedded presentation.',
    'These changes are applied to the in-memory browser bundle; installed runtime files remain unchanged.',
].join('\n');

async function noticeFile(path: string, limit: number, required = false): Promise<string | undefined> {
    let file: FileHandle;
    try { file = await open(path, 'r'); }
    catch (error) {
        if (!required && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
        throw error;
    }
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('Installed editor notice exceeds its size limit or is not a file');
        // One extra byte detects growth without allowing a changed file to allocate beyond its budget.
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
            const result = await file.read(buffer, length, buffer.length - length, length);
            if (!result.bytesRead) break;
            length += result.bytesRead;
        }
        if (length > stat.size) throw new Error('Installed editor notice changed while reading');
        const text = buffer.subarray(0, length).toString('utf8');
        if (required && !text.trim()) throw new Error('Required editor license is empty');
        return text;
    } finally { await file.close(); }
}

function publicRepository(value: unknown): string | undefined {
    const reference = typeof value === 'string' ? value
        : value && typeof value === 'object' && 'url' in value && typeof value.url === 'string' ? value.url : undefined;
    if (!reference || reference.length > 2048) return undefined;
    try {
        const url = new URL(reference.replace(/^git\+/, ''));
        // Installed metadata is not permission to disclose paths or authenticated repository URLs.
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return undefined;
        return reference;
    } catch { return undefined; }
}

/** Notice archive only: compiled runtime files are not represented as preferred corresponding source. */
export async function buildStudioLicenseText(runtime: string, runtimeVersion: string): Promise<string> {
    const sections: string[] = [];
    let bytes = 0;
    const append = (text: string) => {
        bytes += Buffer.byteLength(text, 'utf8') + 2;
        if (bytes > NOTICE_TOTAL_LIMIT) throw new Error('Installed editor notices exceed the combined size limit');
        sections.push(text);
    };
    append(`MotionHarness embedded editor notices\nSelected CLI runtime: ${runtimeVersion}`);
    append(adapterModifications);
    append(`Paws adapter source references (main branch, not a pinned source archive):\n${adapterSource}studioBundle.ts\n${adapterSource}studioHostEntry.ts`);
    append('This download records installed package notices and adapter changes. It does not establish availability or completeness of the upstream preferred corresponding source. Installed dist files are not presented as that source.');
    for (const name of ['studio', 'core', 'sdk', 'ui']) {
        const packageName = '@motionharness/' + name;
        const directory = join(runtime, 'node_modules', packageName);
        append(`===== ${packageName} =====`);
        const raw = await noticeFile(join(directory, 'package.json'), NOTICE_METADATA_LIMIT, name === 'studio');
        if (raw === undefined) {
            append('Package metadata: not present in the selected runtime.');
        } else {
            const metadata = JSON.parse(raw) as { name?: unknown; version?: unknown; license?: unknown; repository?: unknown };
            if (metadata.name !== packageName || typeof metadata.version !== 'string' || !/^[\w.+-]{1,128}$/.test(metadata.version)) {
                throw new Error('Installed editor package metadata is invalid');
            }
            const license = typeof metadata.license === 'string' && metadata.license.length <= 256 ? metadata.license : undefined;
            append('Installed package metadata: ' + JSON.stringify({ name: packageName, version: metadata.version, license,
                repository: publicRepository(metadata.repository) ?? 'No public repository reference included' }));
        }
        for (const filename of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
            const text = await noticeFile(join(directory, filename), NOTICE_FILE_LIMIT, name === 'studio' && filename === 'LICENSE');
            append(`--- ${packageName}/${filename} ---\n${text === undefined ? 'Optional notice file: not present in the selected runtime.' : text}`);
        }
    }
    return sections.join('\n\n');
}

export async function readNativeResponse(url: string, options: RequestInit = {}, limit = 4 * 1024 * 1024): Promise<{ bytes: Buffer; mime: string }> {
    const response = await fetch(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30000) });
    if (!response.ok || !response.body) throw new NativeStudioRequestError(response.status);
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Editor resource exceeds size limit');
    const chunks: Buffer[] = []; let length = 0;
    const reader = response.body.getReader();
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > limit) throw new Error('Editor resource exceeds size limit');
            chunks.push(Buffer.from(chunk.value));
        }
    } finally { await reader.cancel().catch(() => {}); }
    return { bytes: Buffer.concat(chunks), mime: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' };
}

async function installedRuntime(version: string): Promise<string> {
    const candidates: string[] = [];
    if (process.env.PAWS_MOTIONHARNESS_RUNTIME) candidates.push(process.env.PAWS_MOTIONHARNESS_RUNTIME);
    else {
        if (process.platform !== 'darwin') throw new Error('Configure PAWS_MOTIONHARNESS_RUNTIME on this execution machine');
        const cache = join(homedir(), 'Library/Caches/mh/runtime');
        for (const directory of await readdir(cache)) candidates.push(join(cache, directory));
    }
    const matches: string[] = [];
    for (const candidate of candidates) {
        try {
            const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as { name?: string; version?: string };
            if (pkg.name !== '@motionharness/cli' || pkg.version !== version) continue;
            const studio = JSON.parse(await readFile(join(candidate, 'node_modules/@motionharness/studio/package.json'), 'utf8')) as { license?: string };
            if (studio.license !== 'GPL-3.0-only') continue;
            matches.push(await realpath(candidate));
        } catch { /* Unrelated or incomplete native cache. */ }
    }
    if (matches.length !== 1) throw new Error('Configure the matching PAWS_MOTIONHARNESS_RUNTIME; runtime selection is ambiguous or unavailable');
    return matches[0];
}

/** Only document fields needed by Studio cross the boundary, without native access URLs/leases. */
export function publicStudioState(native: Record<string, unknown>): Record<string, unknown> {
    const keys = ['schema', 'buildId', 'generation', 'sourceRevision', 'error', 'preparing', 'sourceCurrent', 'documentConflict',
        'historyOperation', 'document', 'history', 'undoHistory', 'editHistory', 'uiPreferences', 'sourceAssets', 'assets', 'export', 'projectDirectory'];
    return { ...Object.fromEntries(keys.filter(key => key in native).map(key => [key, native[key]])), styles: [] };
}

export async function buildStudioBundle(native: NativeStudio): Promise<{ bytes: Buffer; sha256: string; uncompressedBytes: number }> {
    if (native.version !== '0.1.8') throw new Error('This editor adapter currently supports MotionHarness 0.1.8');
    const runtime = await installedRuntime(native.version);
    const bundler = createRequire(join(runtime, 'package.json'))('esbuild') as Bundler;
    const buildRoot = `${native.origin}${native.base}/build/${encodeURIComponent(String(native.state.generation))}/`;
    const html = (await readNativeResponse(native.origin + native.base + '/')).bytes.toString('utf8');
    const imports = (JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] || '{}') as { imports?: Record<string, string> }).imports ?? {};
    const platform = new Map(Object.entries(imports).map(([specifier, path]) => [new URL(path, native.origin).href, specifier]));
    const nativeModules: Plugin = { name: 'paws-native-composition', setup(build) {
        build.onResolve({ filter: /^paws:composition$/ }, () => ({ path: buildRoot + 'discovery.js', namespace: 'paws-native' }));
        build.onResolve({ filter: /.*/, namespace: 'paws-native' }, async args => {
            if (!args.path.startsWith('.') && !args.path.startsWith('/') && !args.path.includes('://')) {
                return build.resolve(args.path, { resolveDir: runtime, kind: 'import-statement' });
            }
            const url = new URL(args.path, args.importer).href;
            const specifier = platform.get(url);
            if (specifier) return build.resolve(specifier, { resolveDir: runtime, kind: 'import-statement' });
            if (!url.startsWith(buildRoot) || !/\.m?js$/.test(new URL(url).pathname)) throw new Error('Composition import is outside its native build');
            return { path: url, namespace: 'paws-native' };
        });
        build.onLoad({ filter: /.*/, namespace: 'paws-native' }, async args => ({ contents: (await readNativeResponse(args.path)).bytes.toString('utf8'), loader: 'js' }));
        // Native build CSS already includes both Studio and author styles.
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
        build.onLoad({ filter: /[/\\]studio[/\\]CompositionStudio\.js$/ }, async args => {
            let source = await readFile(args.path, 'utf8');
            const timer = 'const timer = setInterval(report, 100);\n        return () => clearInterval(timer);';
            if (!source.includes(timer)) throw new Error('Installed Studio observer contract changed');
            source = source.replace(timer, 'const stopView = studioSession.subscribe(report), stopPlayback = playback.subscribe(report);\n        return () => { stopView(); stopPlayback(); };');
            source = source.replace('agentHook: !props.managedTutorial', 'agentHook: false');
            source = source.replace("setFailure(String(cause));", "{ setFailure(String(cause)); window.dispatchEvent(new CustomEvent('paws-native-diagnostic', { detail: cause instanceof Error ? cause.stack : String(cause) })); }");
            return { contents: source, loader: 'js', resolveDir: resolve(args.path, '..') };
        });
        // The native export preview uses a polling loop. Paws owns export delivery.
        build.onLoad({ filter: /[/\\]studio[/\\]studio-product\.js$/ }, async args => {
            const source = await readFile(args.path, 'utf8');
            if (!source.includes('export: true')) throw new Error('Installed Studio feature contract changed');
            return { contents: source.replace('export: true', 'export: false'), loader: 'js', resolveDir: resolve(args.path, '..') };
        });
    } };
    let css = '';
    for (const path of native.state.styles as string[]) {
        const url = new URL(path, buildRoot);
        if (!url.href.startsWith(buildRoot)) throw new Error('Style is outside native build');
        const source = (await readNativeResponse(url.href)).bytes.toString('utf8');
        for (const match of source.matchAll(/url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi)) {
            const reference = match[1].trim().replace(/^["']|["']$/g, '');
            if (!reference.startsWith('data:') && !reference.startsWith('#')) throw new Error('External Studio CSS resources require explicit packaging');
        }
        css += source;
    }
    css += '\n.studio-notes-foot{display:none!important}';
    const result = await bundler.build({
        stdin: { contents: studioHostEntry, sourcefile: 'paws-motion-host.js', resolveDir: runtime, loader: 'js' },
        bundle: true, write: false, outfile: 'paws-motion-host.js', format: 'esm', platform: 'browser', target: 'chrome120',
        minifyWhitespace: true, minifySyntax: true, keepNames: true, legalComments: 'inline', nodePaths: [join(runtime, 'node_modules')], plugins: [nativeModules],
        define: { 'process.env.NODE_ENV': '"production"' },
    });
    const script = result.outputFiles?.find(file => file.path.endsWith('.js'))?.text;
    if (!script) throw new Error('Editor bundle was not produced');
    if (script.includes(native.base) || css.includes(native.base)) throw new Error('Native credentials must stay on the execution machine');
    const licenseText = await buildStudioLicenseText(runtime, native.version);
    const payload = Buffer.from(JSON.stringify({ script, css, license: 'GPL-3.0-only', licenseText, runtimeVersion: native.version,
        modifications: adapterModifications }));
    if (payload.length > 24 * 1024 * 1024) throw new Error('Editor bundle exceeds size limit');
    const bytes = gzipSync(payload);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), uncompressedBytes: payload.length };
}
