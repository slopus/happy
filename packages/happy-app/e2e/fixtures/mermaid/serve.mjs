import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../../..');
const root = resolve(app, '../..');
const output = await mkdtemp(join(tmpdir(), 'paws-mermaid-e2e-'));
const require = createRequire(resolve(app, 'package.json'));
const icons = resolve(dirname(require.resolve('@expo/vector-icons/package.json')), 'build/vendor/react-native-vector-icons');
// Only --before builds the comparison revision; regular verification uses the current source.
for (const variant of process.argv.includes('--before') ? ['after', 'before', 'native'] : ['after', 'native']) {
    const before = variant === 'before';
    const native = variant === 'native';
    await build({
        entryPoints: [resolve(here, native ? 'native.ts' : 'main.tsx')], outfile: join(output, `${variant}.js`),
        bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.mmd': 'text' },
        resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
        define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
        alias: { 'react-native': 'react-native-web', 'react-native-unistyles': resolve(here, 'theme.ts'), '@': resolve(app, 'sources') },
        plugins: [{ name: 'native-boundaries', setup(builder) {
            const modules = {
                'react-native-webview': 'export const WebView=()=>null;',
                '@/modal': 'export const Modal={alert(){window.dispatchEvent(new Event("fixture-download-error"));}};',
                '@expo/vector-icons': `import React from 'react'; import glyphs from ${JSON.stringify(resolve(icons, 'glyphmaps/Feather.json'))}; export const Feather=({name,size,color})=>React.createElement('span',{'aria-hidden':true,style:{fontFamily:'Feather',fontSize:size,color,lineHeight:1}},String.fromCodePoint(glyphs[name]));`,
                '@/text': `import {zhHans} from ${JSON.stringify(resolve(app, 'sources/text/translations/zh-Hans.ts'))}; export const t=(key)=>key.split('.').reduce((value,part)=>value[part],zhHans);`,
            };
            builder.onResolve({ filter: /.*/ }, args => args.path in modules ? { path: args.path, namespace: 'boundary' } : undefined);
            builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: modules[args.path], loader: 'js', resolveDir: root }));
            if (before) builder.onLoad({ filter: /\/markdown\/MermaidRenderer\.tsx$/ }, args => ({
                contents: execFileSync('git', ['show', '637e64911fb9ae2c840fac6b9d2196909fa46109:packages/happy-app/sources/components/markdown/MermaidRenderer.tsx'], { cwd: root, encoding: 'utf8' }),
                loader: 'tsx', resolveDir: dirname(args.path),
            }));
        } }],
    });
}
const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const asset = url.pathname === '/icons.ttf' ? resolve(icons, 'Fonts/Feather.ttf')
        : ['/before.js', '/after.js', '/native.js'].includes(url.pathname) ? join(output, url.pathname.slice(1)) : null;
    if (asset) {
        try { res.writeHead(200, { 'content-type': asset.endsWith('.ttf') ? 'font/ttf' : 'text/javascript' }); res.end(await readFile(asset)); }
        catch { res.end(); }
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html lang="zh" translate="no"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paws 流程图验收</title><style>@font-face{font-family:Feather;src:url(/icons.ttf)}*{box-sizing:border-box}body{margin:0;font-family:system-ui}</style><div id="root"></div><script src="/${url.pathname === '/native' ? 'native' : url.searchParams.get('revision') === 'before' ? 'before' : 'after'}.js"></script></html>`);
});
server.listen(Number(process.env.MERMAID_FIXTURE_PORT || 49828), '127.0.0.1', () => console.log(`Mermaid actual-component check: http://127.0.0.1:${server.address().port}/?theme=dark`));
