// Controlled browser acceptance: no authentication, network RPC, or package commands.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = fileURLToPath(new URL('.', import.meta.url));
const replacements = new Set(['react-native-unistyles', '@expo/vector-icons', 'expo-clipboard', '@/text', '@/modal', '@/auth/AuthContext', '@/sync/storage', '@/sync/serverConfig', '@/environment/environmentOps', '@/hooks/useCodexAccounts']);
const output = await build({ absWorkingDir: root, entryPoints: [path.join(dir, 'fixture.tsx')], bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
    alias: { 'react-native': 'react-native-web' },
    plugins: [{ name: 'controlled-boundaries', setup(b) { b.onResolve({ filter: /.*/ }, args => replacements.has(args.path) ? { path: path.join(dir, 'boundaries.tsx') } : undefined); } }],
});
const server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(output.outputFiles[0].contents); }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await readFile(path.join(dir, 'index.html'))); }
});
server.listen(4387, '127.0.0.1', () => console.log('Controlled environment dashboard: http://127.0.0.1:4387'));
