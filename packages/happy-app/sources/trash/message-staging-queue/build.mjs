import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = fileURLToPath(new URL('.', import.meta.url));
const boundaries = new Set(['react-native-unistyles', '@expo/vector-icons', '@/text']);
const output = await build({ absWorkingDir: root, entryPoints: [path.join(dir, 'fixture.tsx')], bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
    alias: { 'react-native': 'react-native-web' },
    plugins: [{ name: 'boundaries', setup(b) { b.onResolve({ filter: /.*/ }, args => boundaries.has(args.path) ? { path: path.join(dir, 'boundaries.tsx') } : undefined); } }],
});
createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(output.outputFiles[0].contents); }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>消息队列 · 受控验收</title><style>html,body,#root{margin:0;width:100%;height:100%;font-family:system-ui}*{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer}</style><div id="root"></div><script src="/bundle.js"></script></html>'); }
}).listen(4391, '127.0.0.1', () => console.log('Queue acceptance: http://127.0.0.1:4391/'));
