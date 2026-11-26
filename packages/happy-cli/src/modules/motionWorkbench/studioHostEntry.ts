/** Browser-only adapter source bundled against the installed editor, not a vendored editor implementation. */
export const studioHostEntry = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Studio,createDirectWorkRuntime,createOperationTransport} from '@motionharness/studio';
import {composition,schema,buildId} from 'paws:composition';

const pending=new Map(); const assetUrls={}; let sequence=0, port, project, handle, closed=false;
window.addEventListener('error',event=>port?.postMessage({type:'error',message:event.message}));
window.addEventListener('unhandledrejection',event=>port?.postMessage({type:'error',message:String(event.reason)}));
window.addEventListener('paws-native-diagnostic',event=>port?.postMessage({type:'diagnostic',message:event.detail}));
function acceptAssets(assets=[]){for(const asset of assets){if(!assetUrls[asset.id])assetUrls[asset.id]=URL.createObjectURL(new Blob([asset.bytes],{type:asset.mime}));}}
function call(type,input){
  if(closed) return Promise.reject(new Error('Editor is closed'));
  return new Promise((resolve,reject)=>{const id=++sequence;
    const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('Paws request timed out'));},180000);
    pending.set(id,{resolve,reject,timeout});port.postMessage({id,type,input});
  });
}
function createSession(initial,assetUrls){
  let snapshot={state:initial,connection:'connected',save:{pending:0,phase:'idle'}}, disposed=false;
  const listeners=new Set(),views=new Set();
  const notify=change=>{if(disposed)return;snapshot=Object.freeze({...snapshot,...change});for(const f of listeners)f();};
  const accept=value=>{
    const state=value?.document&&value?.schema?value:value?.state;
    if(!state?.document||!state?.schema)return;
    if(state.buildId!==buildId){port.postMessage({type:'source-changed'});throw new Error('Source changed; reopen the editor to load the new build');}
    if(state.document.revision<snapshot.state.document.revision)return;
    notify({state,connection:'connected'});
  };
  const transport=createOperationTransport(async(path,body)=>{
    if(path==='agent-sync')return {enabled:true,agents:[]};
    const result=await call('operation',{route:path,body});accept(result);return result;
  });
  transport.subscribe(()=>notify({save:transport.read()}));
  const refresh=async()=>{try{const state=await call('state',{});accept(state);return snapshot.state;}catch(e){notify({connection:'disconnected'});throw e;}};
  return {
    id:'paws-project',transport,request:transport.request,getSnapshot:()=>snapshot,
    subscribe:f=>{listeners.add(f);return()=>listeners.delete(f);},refresh,reconnect:refresh,
    createClientId:()=>crypto.randomUUID(),attachView:view=>{views.add(view);return()=>views.delete(view);},
    content:{
      async loadBuild(state,{signal}){signal.throwIfAborted();if(state.buildId!==buildId||JSON.stringify(state.schema)!==JSON.stringify(schema))throw new Error('Project build changed');
        return {runtime:createDirectWorkRuntime({composition}),activate(){},dispose(){}};},
      assetUrl:reference=>{const url=assetUrls[reference.$asset];if(!url)throw new Error('Project asset is unavailable');return url;},
      downloadProject:async()=>{throw new Error('Use the Paws project download action');},exportArtifactUrl:()=>'',
    },
    context:()=>[...views][0]?.read(),
    disconnect:()=>notify({connection:'disconnected'}),
    dispose(){disposed=true;transport.close();listeners.clear();views.clear();},
  };
}
function mount(data){
  if(project||closed)return;
  let studioTheme=data.theme||'dark';
  port.onmessage=async event=>{
    const message=event.data;
    if(message.type==='result'){
      const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timeout);
      if(message.error)request.reject(new Error(message.error));else{acceptAssets(message.assets);request.resolve(message.value);}return;
    }
    if(message.type==='refresh'){try{await project?.refresh();}catch(e){port.postMessage({type:'error',message:String(e)});}return;}
    if(message.type==='connection'){if(message.connected){try{await project?.refresh();}catch(e){port.postMessage({type:'error',message:String(e)});}}else{project?.disconnect();handle?.dispatch({type:'playback',operation:{type:'pause'}});}return;}
    if(message.type==='context'){port.postMessage({type:'context',id:message.id,value:project?.context()});return;}
    if(message.type==='theme'&&['light','dark'].includes(message.value)){studioTheme=message.value;renderStudio();return;}
    if(message.type==='visibility'&&!message.visible){handle?.dispatch({type:'playback',operation:{type:'pause'}});return;}
    if(message.type==='seek'&&Number.isFinite(message.time)){handle?.dispatch({type:'playback',operation:{type:'seek',time:message.time}});return;}
    if(message.type==='prepare-close'){try{await handle?.prepareProjectReopen();await project?.transport.flush();port.postMessage({type:'close-ready',id:message.id});}catch(e){port.postMessage({type:'close-blocked',id:message.id,message:String(e)});}return;}
    if(message.type==='dispose'){closed=true;observer.disconnect();project?.dispose();for(const request of pending.values()){clearTimeout(request.timeout);request.reject(new Error('Editor closed'));}pending.clear();root?.unmount();for(const url of Object.values(assetUrls))URL.revokeObjectURL(url);port.close();return;}
  };
  acceptAssets(data.assets);project=createSession(data.state,assetUrls);
  const root=createRoot(document.getElementById('root'));
  const observer=new MutationObserver(()=>{if(document.querySelector('[data-testid="composition-stage"]')){observer.disconnect();port.postMessage({type:'ready'});}});
  observer.observe(document.getElementById('root'),{childList:true,subtree:true});
  function renderStudio(){root.render(React.createElement(Studio,{project,hostVersion:'Paws / MotionHarness 0.1.8',theme:studioTheme,locale:'zh-CN',
    ref:value=>{handle=value;},hostActions:()=>React.createElement('button',{type:'button',onClick:()=>port.postMessage({type:'review-request'})},'交给 Paws AI'),
  }));}
  renderStudio();
}
const channel=new MessageChannel();port=channel.port1;
port.onmessage=event=>{if(event.data?.type==='paws-motion-connect')mount(event.data);};
parent.postMessage({type:'paws-motion-frame-ready',nonce:document.querySelector('meta[name="paws-motion-channel"]')?.content},'*',[channel.port2]);
`;
