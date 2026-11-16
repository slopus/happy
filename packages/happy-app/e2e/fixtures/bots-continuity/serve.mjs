import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../../..');
const output = await mkdtemp(join(tmpdir(), 'paws-bots-continuity-'));
await build({ entryPoints:[join(here,'main.tsx')],outfile:join(output,'app.js'),bundle:true,loader:{'.png':'dataurl'},platform:'browser',format:'iife',jsx:'automatic',resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],define:{'process.env.NODE_ENV':'"development"',__DEV__:'false'},alias:{'react-native':'react-native-web','react-native-unistyles':resolve(here,'../ai-services/theme.ts'),'@':resolve(app,'sources')},plugins:[{name:'fixture-boundaries',setup(b){
const modules={
'expo-router':`export {useNavigation} from '@react-navigation/native'; export const withLayoutContext=c=>c;`,
'@expo/vector-icons':`export const Feather=()=>null;export const Ionicons=()=>null;`,
'@/auth/AuthContext':`export const useAuth=()=>({credentials:{token:'fixture-account'}});`,
'@/sync/storage':`export const useSetting=()=> 'zh-Hans';`,
'@/sync/serverConfig':`export const getServerUrl=()=> 'http://127.0.0.1:49839';`,
'@/utils/responsive':`export const useIsTablet=()=>true;`,
'@/components/StyledText':`export {Text} from 'react-native';`,
'@/text':`export const t=k=>k;`,
'@/hooks/useDesktopWorkspaceLayout':`export const DesktopWorkspaceLayoutIsolation=({children})=>children;`,
};
b.onResolve({filter:/.*/},args=>args.path in modules?{path:args.path,namespace:'fixture'}:undefined);
b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path],loader:'js',resolveDir:app}));
}}]});
createServer(async(req,res)=>{
if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(join(output,'app.js')));return;}
if(req.url==='/runtime.js'){res.setHeader('content-type','text/javascript');res.end(`window.PawsBots={mount(host,options){window.__stats.mounts++;host.innerHTML='<label>Draft <input aria-label="Draft"></label>';options.onAuthenticated();return ()=>{window.__stats.disposals++;host.replaceChildren()}}}`);return;}
if(req.url==='/runtime.css'){res.setHeader('content-type','text/css');res.end('');return;}
res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><meta name="paws-bots-entry" content="/runtime.js"><meta name="paws-bots-style" content="/runtime.css"><style>html,body,#root{margin:0;height:100%;}#root{display:flex;flex-direction:column}nav{padding:12px}button{margin:4px;padding:8px}</style><div id="root"></div><script src="/app.js"></script>');
}).listen(49839,'127.0.0.1',()=>console.log('http://127.0.0.1:49839/'));
