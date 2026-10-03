// Local UI regression: real routes/components/theme tokens, deterministic API/auth boundaries.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const app=path.join(root,'packages/happy-app/sources');
const out=path.join(root,'test-results/app-authorization-ui'); await mkdir(out,{recursive:true});
const id='11111111-1111-4111-8111-111111111111';
const virtual={
 'react-native-unistyles':`import {appThemes} from '${app}/themePacks';const theme=appThemes[new URLSearchParams(location.search).get('theme')||'ginghamDark'];export const StyleSheet={create:f=>typeof f==='function'?f(theme,{insets:{top:0,bottom:0}}):f,hairlineWidth:1};export const useUnistyles=()=>({theme});`,
 'expo-router':`import React from 'react';export const Stack={Screen:()=>null};export const useLocalSearchParams=()=>({id:'${id}'});export const useRouter=()=>({back(){window.fixtureNavigation='back'},replace(){location.href='/list'}});export const useFocusEffect=fn=>React.useEffect(fn,[fn]);`,
 '@/components/layout':`export const layout={maxWidth:800};`,
 '@/text':`import{zhHans}from'${app}/text/translations/zh-Hans';export const t=(key,args)=>{const v=key.split('.').reduce((o,k)=>o?.[k],zhHans);return typeof v==='function'?v(args):v??key};`,
 '@/auth/AuthContext':`const credentials={token:'isolated-ui-fixture'};export const useAuth=()=>({credentials});`,
 '@/sync/storage':`const machines=new URLSearchParams(location.search).has('empty')?[]:[{id:'mac-mini',metadata:{displayName:'Mac mini',host:'mac-mini.local'}},{id:'macbook',metadata:{displayName:'MacBook Pro',host:'macbook.local'}}];export const useAllMachines=()=>machines;`,
 '@/sync/sync':`export const sync={encryption:{getMachineEncryption:()=>({encryptRaw:async()=> 'fixture-envelope'})}};`,
 '@/encryption/libsodium':`export const encryptBox=()=>new Uint8Array(32);`,
 'expo-crypto':`export const getRandomBytes=n=>crypto.getRandomValues(new Uint8Array(n));`,
 '@/components/haptics':`export const hapticsLight=()=>{};`,
 '@/modal':`export const Modal={confirm:async()=>window.confirm('撤销此测试连接？'),alert:()=>{}};`,
 'expo-clipboard':`export const setStringAsync=async()=>{};`,
 '@/sync/serverConfig':`export const getServerUrl=()=>location.origin;`,
 '@/sync/apiAppDelegation':`export {isAppGrantActive} from '${app}/sync/apiAppDelegation';let grants=[{id:'active',appId:'relationship-advisor',machineId:'mac-mini',state:'redeemed',expiresAt:null},{id:'revoked',appId:'relationship-advisor',machineId:'macbook',state:'revoked',expiresAt:'2027-10-04T06:00:00Z'}];window.fixtureApprovals=[];export async function appAuthorizationRequest(token,path,body,method){if(path==='/workers')return{workers:[{machineId:'mac-mini',protocol:2},{machineId:'macbook',protocol:1}]};if(path.endsWith('/approve')){window.fixtureApprovals.push(body);await new Promise(r=>setTimeout(r,1400));if(window.fixtureFail)throw Error('测试请求失败，请重试');return{};}if(path.startsWith('/requests/'))return{id:'${id}',supportsPermanent:true,publicKey:btoa('0'.repeat(32)),app:{id:'relationship-advisor',name:'狗头军师',origin:'https://advisor.paws.rodeo'}};if(method==='DELETE'){await new Promise(r=>setTimeout(r,600));grants=grants.map(g=>g.id===path.slice(1)?{...g,state:'revoked'}:g);return{};}return{grants};}`,
};
await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Authorize from '${app}/app/(app)/apps/authorize';import List from '${app}/app/(app)/settings/authorized-apps';import{appThemes}from'${app}/themePacks';const theme=appThemes[new URLSearchParams(location.search).get('theme')||'ginghamDark'];document.body.style.background=theme.colors.groupped.background;createRoot(document.getElementById('root')).render(location.pathname==='/list'?<List/>:<Authorize/>);`,loader:'tsx',resolveDir:path.join(root,'packages/happy-app')},bundle:true,platform:'browser',format:'esm',outfile:path.join(out,'app.js'),define:{'process.env':'{}','process.env.EXPO_OS':'"web"','process.env.NODE_ENV':'"development"','__DEV__':'true','global':'globalThis'},alias:{'react-native':'react-native-web','@':app},loader:{'.ttf':'file','.png':'file','.js':'jsx'},resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},args=>args.path in virtual?{path:args.path,namespace:'virtual'}:undefined);b.onLoad({filter:/.*/,namespace:'virtual'},args=>({contents:virtual[args.path],loader:'tsx',resolveDir:path.join(root,'packages/happy-app')}));}}]});
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paws 授权页交互验收</title><style>html,body,#root{margin:0;height:100%;width:100%}#root{display:flex;flex-direction:column}*{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/app.js"></script></html>`;
createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://127.0.0.1').pathname;if(pathname.endsWith('.js')||pathname.endsWith('.ttf')){res.setHeader('content-type',pathname.endsWith('.js')?'text/javascript':'font/ttf');res.end(await readFile(path.join(out,path.basename(pathname))));}else{res.setHeader('content-type','text/html');res.end(html);}}catch{res.writeHead(404);res.end();}}).listen(18796,'127.0.0.1',()=>console.log('Authorization UI fixture: http://127.0.0.1:18796/'));
