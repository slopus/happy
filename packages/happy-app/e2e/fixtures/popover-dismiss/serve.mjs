import {build} from 'esbuild';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const here=dirname(fileURLToPath(import.meta.url)), app=resolve(here,'../../..');
const mocks={
 '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span',{'aria-hidden':true},'·');`,
 '@/constants/Typography': 'export const Typography={default:()=>({})};',
 '@/sync/storage': 'export const storage={getState:()=>({updateSessionModelMode(){},updateSessionEffortLevel(){}})};export const useSetting=()=>null;',
 '@/text': 'export const t=k=>k;',
 '@/modal': 'export const Modal={alert(){}};',
 'expo-clipboard': 'export const setStringAsync=async()=>{};',
 '@/utils/newSessionExperience': 'export const getRunningSessionInfoExperience=()=>({showPath:true,showModelDetails:true,showPermission:true});',
 '@/utils/runningSessionTurnModes': `export const resolveRunningSessionTurnModes=()=>({availableModels:[{key:'a',name:'Model A'},{key:'b',name:'Model B'}],modelMode:{key:'a',name:'Model A'},availableEffortLevels:[{key:'high',name:'high'},{key:'max',name:'max'}],effortLevel:{key:'high',name:'high'}});`,
 '@/hooks/useSessionTaskPermission': `export const useSessionTaskPermission=()=>({level:'confirm',supported:true,onLevelChange:async()=>true});`,
};
const bundle=await build({entryPoints:[resolve(here,'main.tsx')],write:false,bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"',__DEV__:'true'},alias:{'react-native':'react-native-web','react-native-unistyles':resolve(here,'../ai-services/theme.ts'),'@':resolve(app,'sources')},plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>a.path in mocks?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js',resolveDir:app}));}}]});
createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<!doctype html><html><meta charset="utf-8"><title>Paws 浮层关闭验收</title><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>');}).listen(49839,'127.0.0.1',()=>console.log('http://127.0.0.1:49839/'));
