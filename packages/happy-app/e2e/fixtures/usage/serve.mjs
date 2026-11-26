import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../../..');
const root = resolve(app, '../..');
const output = await mkdtemp(join(tmpdir(), 'paws-usage-'));
const variants = process.argv.includes('--before') ? ['after', 'before'] : ['after'];
for (const variant of variants) {
    await build({
        entryPoints: [join(here, 'main.tsx')], outfile: join(output, `${variant}.js`), bundle: true,
        platform: 'browser', format: 'iife', jsx: 'automatic',
        resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
        define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
        alias: { 'react-native': 'react-native-web', 'react-native-unistyles': join(here, 'theme.ts'), '@': join(app, 'sources') },
        plugins: [{ name: 'usage-fixture-boundaries', setup(builder) {
            const modules = {
                'react-native-safe-area-context': 'export const useSafeAreaInsets=()=>({top:0,left:0,right:0,bottom:0});',
                '@/components/StyledText': 'export { Text } from "react-native";',
                '@expo/vector-icons': 'export const Ionicons=()=>null;',
                '@/auth/AuthContext': 'const auth={credentials:{token:"fixture-only"}}; export const useAuth=()=>auth;',
                '@/sync/storage': `import {machine} from ${JSON.stringify(join(here, 'data.ts'))}; export const storage=selector=>selector({currentViewingSessionId:'fixture',sessions:{fixture:{metadata:{machineId:machine.id}}}}); export const useAllMachines=()=>[machine];`,
                '@/hooks/useCodexAccounts': `import {profiles} from ${JSON.stringify(join(here, 'data.ts'))}; export const useCodexAccounts=()=>({profiles,bindings:[]});`,
                '@/sync/apiUsage': 'export const getUsageForPeriod=async()=>({usage:[]}); export const calculateTotals=()=>({totalTokens:0,totalCost:0,tokensByModel:{},costByModel:{}});',
                '@/sync/apiSocket': 'export const apiSocket={machineRPC:async()=>({type:"success"})};',
                '@/utils/errors': 'export class HappyError extends Error{}',
                '@/text': `import {zhHans} from ${JSON.stringify(join(app, 'sources/text/translations/zh-Hans.ts'))}; export const getCurrentLanguage=()=> 'zh-Hans'; export const t=(key,values)=>{const result=key.split('.').reduce((value,part)=>value?.[part],zhHans);return typeof result==='function'?result(values):result??key;};`,
                './UsageChart': 'export const UsageChart=()=>null;',
                './UsageBar': 'export const UsageBar=()=>null;',
                '@/components/ItemGroup': 'export const ItemGroup=({children})=>children;',
            };
            builder.onResolve({ filter: /.*/ }, args => args.path in modules ? { path: args.path, namespace: 'fixture' } : undefined);
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: modules[args.path], loader: 'js', resolveDir: root }));
            if (variant === 'before') builder.onLoad({ filter: /\/usage\/UsagePanel\.tsx$/ }, args => ({
                contents: execFileSync('git', ['show', '62e86e1e1d3083e3a01798bfacc403bd89048c8c:packages/happy-app/sources/components/usage/UsagePanel.tsx'], { cwd: root, encoding: 'utf8' }),
                loader: 'tsx', resolveDir: dirname(args.path),
            }));
        } }],
    });
}

const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (variants.some(variant => url.pathname === `/${variant}.js`)) {
        response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        response.end(await readFile(join(output, url.pathname.slice(1)))); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const variant = url.searchParams.get('revision') === 'before' && variants.includes('before') ? 'before' : 'after';
    response.end(`<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paws 使用情况组件验收</title><style>html,body,#root{margin:0;min-height:100%;font-family:system-ui}body{background:${url.searchParams.get('theme') === 'light' ? '#fafafa' : '#121b2c'}}nav a,nav button{font:inherit;font-size:12px}</style><div id="root"></div><script src="/${variant}.js"></script></html>`);
});
server.listen(Number(process.env.USAGE_FIXTURE_PORT || 49847), '127.0.0.1', () => console.log(`Usage fixture: http://127.0.0.1:${server.address().port}/?theme=dark`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await rm(output, { recursive: true, force: true }); process.exit(0); }));
