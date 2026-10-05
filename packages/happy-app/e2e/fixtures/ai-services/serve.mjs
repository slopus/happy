import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../../..');
const output = resolve(here, '../../../../../.superpowers/sdd/2026-10-05-paws-shared-ai-service/task-7-fixture');
await mkdir(output, { recursive: true });
await build({ entryPoints: [resolve(here, 'main.tsx')], outfile: resolve(output, 'bundle.js'), bundle: true, resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.ts', '.tsx', '.js', '.android.js', '.json'], platform: 'browser', format: 'iife', jsx: 'automatic', sourcemap: true, define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' }, alias: { 'react-native': 'react-native-web', 'react-native-unistyles': resolve(here, 'theme.ts'), '@': resolve(app, 'sources') }, plugins: [{ name: 'fixture-native-boundaries', setup(b) {
    b.onResolve({ filter: /^@expo\/vector-icons$/ }, () => ({ path: 'icons', namespace: 'fixture' }));
    b.onResolve({ filter: /^@\/components\/layout$/ }, () => ({ path: 'layout', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)serverConfig$/ }, () => ({ path: 'server', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'icons' ? 'export const Ionicons = () => null;' : args.path === 'layout' ? 'export const layout = {maxWidth:800};' : 'export const getServerUrl = () => { throw new Error("Synthetic fixture has no server"); };', loader: 'js' }));
} }] });
await writeFile(resolve(output, 'index.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paws AI 服务 · 合成验收</title><style>html,body,#root{height:100%;}*{box-sizing:border-box;}</style><div id="root"></div><script src="/bundle.js"></script></html>');
const server = createServer(async (req, res) => {
    const name = req.url?.split('?')[0] === '/bundle.js' ? 'bundle.js' : req.url?.split('?')[0] === '/bundle.js.map' ? 'bundle.js.map' : 'index.html';
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.map') ? 'application/json' : 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store'); res.end(await readFile(resolve(output, name)));
});
server.listen(49817, '127.0.0.1', () => process.stdout.write('Task 7 actual-component fixture: http://127.0.0.1:49817/?case=list&theme=dark\n'));
