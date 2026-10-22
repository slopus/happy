import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../../..');
const root = resolve(app, '../..');
const output = await mkdtemp(join(tmpdir(), 'paws-independent-e2e-'));
await build({ entryPoints: [resolve(here, 'main.tsx')], outfile: resolve(output, 'app.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
    alias: { 'react-native': 'react-native-web', 'react-native-unistyles': resolve(here, '../ai-services/theme.ts'), '@': resolve(app, 'sources') },
    plugins: [{ name: 'fixture-boundaries', setup(b) {
        const modules = {
            '@expo/vector-icons': `import React from 'react'; export const Ionicons=()=>React.createElement('span',{'aria-hidden':true},'↗');`,
            '@/sync/storage': `import {useSyncExternalStore} from 'react';
                let state={'child-1':{thinking:true,agentState:{turnStatus:{status:'running'}}},'child-2':{thinking:true,agentState:{turnStatus:{status:'running'}}}};
                const listeners=new Set();
                window.addEventListener('fixture-state',e=>{state=e.detail==='completed'?{...state,'child-1':{thinking:false,agentState:{turnStatus:{status:'completed'}}}}:{...state,'child-2':{thinking:false,agentState:{requests:{permission:{tool:'exec'}}}}};for(const l of listeners)l();});
                export const useSession=id=>useSyncExternalStore(l=>{listeners.add(l);return()=>listeners.delete(l)},()=>state[id]);`,
            '@/hooks/useNavigateToSession': `export const useNavigateToSession=()=>id=>{history.pushState({},'', '/session/'+encodeURIComponent(id));window.dispatchEvent(new PopStateEvent('popstate'));};`,
        };
        b.onResolve({ filter: /.*/ }, args => args.path in modules ? { path: args.path, namespace: 'fixture' } : undefined);
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: modules[args.path], loader: 'js', resolveDir: root }));
    } }],
});
const server = createServer(async (req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(resolve(output, 'app.js'))); return; }
    res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
    res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>独立会话组件验收</title><style>body{font-family:system-ui;margin:0}button{margin:12px;padding:10px}output{display:block}</style><div id="root"></div><script src="/app.js"></script></html>');
});
server.listen(49831, '127.0.0.1', () => console.log('http://127.0.0.1:49831/?theme=dark'));
