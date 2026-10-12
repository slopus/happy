import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../../..');
const root = resolve(app, '../..');
const output = await mkdtemp(join(tmpdir(), 'paws-question-card-e2e-'));
const icons = resolve(root, 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons');
const emptyComponents = ['SimpleSyntaxHighlighter', 'OtaPreviewCard', 'FinanceChartCard', 'MermaidRenderer', 'CodeBlockCopyButton'];
for (const before of [false, true]) {
    await build({ entryPoints: [resolve(here, 'main.tsx')], outfile: resolve(output, before ? 'before.js' : 'after.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
        resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
        define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
        alias: { 'react-native': 'react-native-web', 'react-native-unistyles': resolve(here, '../ai-services/theme.ts'), '@': resolve(app, 'sources') },
        plugins: [{ name: 'isolated-native-boundaries', setup(b) {
            const modules = {
                '@expo/vector-icons': `import React from 'react'; import glyphs from ${JSON.stringify(resolve(icons, 'glyphmaps/Ionicons.json'))}; export const Ionicons=({name,size,color})=>React.createElement('span',{'aria-hidden':true,style:{fontFamily:'Ionicons',fontSize:size,color,lineHeight:1}},String.fromCodePoint(glyphs[name]));`,
                'react-native-gesture-handler': 'export const Gesture={}; export const GestureDetector=({children})=>children;',
                '@/sync/storage': 'export const useLocalSetting=()=>false;',
                '@/sync/persistence': 'export const storeTempText=()=>"fixture";',
                '@/sync/imageViewer': 'export const imageViewer={open(){}};',
                'expo-router': 'export const useRouter=()=>({push(){}});',
                'expo-web-browser': 'export {};',
                '@/modal': 'export const Modal={alert(){window.dispatchEvent(new Event("fixture-send-error"));}};',
                '@/text': `import {zhHans} from ${JSON.stringify(resolve(app, 'sources/text/translations/zh-Hans.ts'))}; export const t=(key)=>key.split('.').reduce((value,part)=>value[part],zhHans);`,
                '@/utils/openExternalUrl': 'export const openExternalUrl=()=>{};',
                '@/components/agents/imageStyleOptions': 'export const MAX_IMAGE_STYLE_OPTION_COUNT=10; export const parseImageStyleOptions=()=>[]; export const buildImageStyleContinuationPrompt=()=>"";',
                '@/components/agents/imageAgentPrompt': 'export const MAX_IMAGE_AGENT_VARIANTS_PER_STYLE=4;',
            };
            b.onResolve({ filter: /.*/ }, args => {
                if (args.path in modules) return { path: args.path, namespace: 'boundary' };
                const name = args.path.split('/').pop();
                if (emptyComponents.includes(name)) return { path: name, namespace: 'empty' };
                if (name === 'HorizontalScrollView') return { path: name, namespace: 'scroll' };
                if (name === 'haptics') return { path: name, namespace: 'haptics' };
            });
            b.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: modules[args.path], loader: 'js', resolveDir: root }));
            b.onLoad({ filter: /.*/, namespace: 'empty' }, args => ({ contents: `export const ${args.path}=()=>null;`, loader: 'js' }));
            b.onLoad({ filter: /.*/, namespace: 'scroll' }, () => ({ contents: 'export {ScrollView as HorizontalScrollView} from "react-native-web";', loader: 'js', resolveDir: root }));
            b.onLoad({ filter: /.*/, namespace: 'haptics' }, () => ({ contents: 'export const hapticsLight=()=>{};', loader: 'js' }));
            if (before) b.onLoad({ filter: /\/markdown\/MarkdownView\.tsx$/ }, args => ({ contents: execFileSync('git', ['show', '7c57bc20:packages/happy-app/sources/components/markdown/MarkdownView.tsx'], { cwd: root, encoding: 'utf8' }), loader: 'tsx', resolveDir: dirname(args.path) }));
        } }],
    });
}
const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/reply' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const reply = JSON.parse(body);
        await new Promise(resolve => setTimeout(resolve, 600));
        res.writeHead(reply.fail ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: !reply.fail, title: reply.title })); return;
    }
    const fonts = { '/icons.ttf': resolve(icons, 'Fonts/Ionicons.ttf'), '/mono.ttf': resolve(app, 'sources/assets/fonts/MapleMonoNL-Regular.ttf'), '/mono-bold.ttf': resolve(app, 'sources/assets/fonts/MapleMonoNL-SemiBold.ttf') };
    if (url.pathname in fonts) { res.writeHead(200, { 'content-type': 'font/ttf' }); res.end(await readFile(fonts[url.pathname])); return; }
    if (['/before.js', '/after.js'].includes(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(resolve(output, url.pathname.slice(1)))); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html lang="zh" translate="no"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paws 问答卡片验收</title><style>@font-face{font-family:Ionicons;src:url(/icons.ttf)}@font-face{font-family:MapleMonoNL-Regular;src:url(/mono.ttf)}@font-face{font-family:MapleMonoNL-SemiBold;src:url(/mono-bold.ttf)}*{box-sizing:border-box}body{margin:0;font-family:system-ui}button{font:inherit;cursor:pointer}small{opacity:.7}</style><div id="root"></div><script src="/${url.searchParams.get('revision') === 'before' ? 'before' : 'after'}.js"></script></html>`);
});
server.listen(49827, '127.0.0.1', () => console.log('Question card actual-component E2E: http://127.0.0.1:49827/?theme=dark'));
