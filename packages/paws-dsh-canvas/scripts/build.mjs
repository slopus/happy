import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(workspace, 'package.json'));
const upstream = join(workspace, 'vendor', 'dsh-image-gen');
const output = join(workspace, '..', 'happy-app', 'public', 'dsh-image-canvas');
const renderer = join(upstream, 'src', 'client', 'tl');
const studio = join(renderer, 'studio-tl-canvas.tsx');
const host = join(workspace, 'src', 'host');

if (process.env.PAWS_PROJECT_CANVAS_BUILD_DISABLED === '1') {
    await rm(output, { recursive: true, force: true });
    console.log('Project Canvas renderer omitted from this Web build');
    process.exit(0);
}

execFileSync(process.execPath, [join(workspace, 'scripts', 'sync-upstream.mjs'), '--check'], { stdio: 'inherit' });

// Resolve the four host seams in the original Studio source. Missing seams or
// additional host-only runtime dependencies must surface on the next upgrade.
const seams = new Map([
    ['tldraw', 'tldraw.tsx'],
    ['../image-cache.js', 'imageCache.ts'],
    ['./canvas-sync.js', 'canvasSync.ts'],
    ['../../shared.js', 'shared.ts'],
]);
const used = new Set();
const sdkRoot = dirname(require.resolve('tldraw/tldraw.css'));
const packageJson = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
const provenance = JSON.parse(await readFile(join(workspace, 'vendor', 'upstream.json'), 'utf8'));
const originalPackage = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'));
const expectedSdk = originalPackage.devDependencies?.tldraw;
if (packageJson.dependencies.tldraw !== expectedSdk || packageJson.dependencies['@tldraw/assets'] !== expectedSdk) {
    throw new Error(`Update canvas SDK and static assets to match upstream tldraw ${expectedSdk}`);
}

// Keep the regular toolbar sprite and asset URLs. The SDK already loads fonts
// used by shapes and the embed dialog loads its own icons when it opens.
const sdkStartupEdits = new Map([
    [join(sdkRoot, 'dist-esm/lib/Tldraw.mjs'), {
        before: `    editor.fonts.requestFonts(allDefaultFontFaces);
    const themes = editor.getThemes();
    for (const theme of Object.values(themes)) {
      for (const key of Object.keys(theme.fonts)) {
        const font = theme.fonts[key];
        if (font.faces?.length) {
          editor.fonts.requestFonts(font.faces);
        }
      }
    }
`,
        after: '',
    }],
    [join(sdkRoot, 'dist-esm/lib/ui/context/asset-urls.mjs'), {
        before: '[...Object.values(assetUrls.icons), ...Object.values(assetUrls.embedIcons)]',
        after: 'Object.values(assetUrls.icons)',
    }],
]);
const appliedStartupEdits = new Set();

await mkdir(dirname(output), { recursive: true });
const temporary = await mkdtemp(join(dirname(output), '.dsh-canvas-build-'));
try {
    const result = await build({
        absWorkingDir: workspace,
        entryPoints: { canvas: 'src/index.tsx' },
        outdir: temporary,
        platform: 'browser',
        format: 'esm',
        bundle: true,
        minify: true,
        metafile: true,
        legalComments: 'linked',
        jsx: 'automatic',
        target: ['es2022'],
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [{
            name: 'paws-canvas-host',
            setup(builder) {
                builder.onResolve({ filter: /.*/ }, args => {
                    if (args.importer === studio && seams.has(args.path)) {
                        used.add(args.path);
                        return { path: join(host, seams.get(args.path)) };
                    }
                    if (args.importer.startsWith(renderer + '/') && args.path === '../../shared.js') {
                        return { path: join(host, 'shared.ts') };
                    }
                    // Hoisted Paws packages use React 19. The frame and every
                    // dependency use the React 18 instance from this workspace.
                    if (/^react(?:-dom)?(?:\/|$)/.test(args.path)) return { path: require.resolve(args.path) };
                });
                builder.onLoad({ filter: /[\\/](?:Tldraw|asset-urls)\.mjs$/ }, async ({ path }) => {
                    const edit = sdkStartupEdits.get(path);
                    if (!edit) return;
                    const source = await readFile(path, 'utf8');
                    const offset = source.indexOf(edit.before);
                    if (offset < 0 || offset !== source.lastIndexOf(edit.before)) {
                        throw new Error(`tldraw ${expectedSdk} startup preloads changed in ${relative(sdkRoot, path)}`);
                    }
                    appliedStartupEdits.add(path);
                    return { contents: source.replace(edit.before, edit.after), resolveDir: dirname(path) };
                });
            },
        }],
    });
    if (appliedStartupEdits.size !== sdkStartupEdits.size) {
        throw new Error(`tldraw ${expectedSdk} startup modules changed; review the preload adapter before building`);
    }
    if (used.size !== seams.size || !result.metafile.inputs[relative(workspace, studio)]) {
        throw new Error('Upstream Studio runtime seams changed; review the adapter before building');
    }
    if (Object.keys(result.metafile.inputs).some(file => /(?:@deepseek-ai|(?:^|\/)vendor\/dsh-image-gen\/.*\/(image-cache|canvas-sync)\.)/.test(file))) {
        throw new Error('DeepSeek Harness code must stay outside the Paws runtime bundle');
    }
    const originalInputs = Object.keys(result.metafile.inputs)
        .map(file => relative(upstream, resolve(workspace, file)))
        .filter(file => file.startsWith('src/')).sort();
    await writeFile(join(temporary, 'upstream-build.json'), JSON.stringify({
        repository: provenance.repository, version: provenance.version, commit: provenance.commit,
        sdk: expectedSdk, originalInputs,
    }, null, 2) + '\n');
    const sdk = dirname(require.resolve('@tldraw/assets/package.json'));
    for (const directory of ['fonts', 'icons', 'translations', 'embed-icons']) {
        await cp(join(sdk, directory), join(temporary, 'assets', directory), { recursive: true });
    }
    await cp(join(upstream, 'LICENSE'), join(temporary, 'DSH-Image-Gen-LICENSE.txt'));
    await cp(join(workspace, 'vendor', 'NOTICE'), join(temporary, 'NOTICE.txt'));
    await cp(join(workspace, 'licenses', `tldraw-${expectedSdk}-LICENSE.md`), join(temporary, 'tldraw-LICENSE.md'));
    await writeFile(join(temporary, 'index.html'), `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' blob: data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'">
<title>Paws 项目画布</title>
<link rel="stylesheet" href="./canvas.css">
<div id="root"></div>
<script type="module" src="./canvas.js"></script>
</html>\n`);
    await rm(output, { recursive: true, force: true });
    await rename(temporary, output);
    console.log(`Built DSH Image Gen Studio with tldraw ${expectedSdk} for Paws Web`);
} finally {
    await rm(temporary, { recursive: true, force: true });
}
