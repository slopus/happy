import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run, writeJSON, fingerprint } from './io.mjs';

export const BVID = /^BV[0-9A-Za-z]{10}$/;
const marker = 'CARD_STUDIO_RESULT:';

async function execute(source, options = {}) {
  const output = await run(options.egoBin || 'ego-browser', ['nodejs', '-e', source], { signal: options.signal, timeout: 8 * 60_000, captureStderr: true });
  const result = output.split('\n').find(line => line.startsWith(marker));
  if (!result) throw new Error('Ego 未返回结构化采集回执。');
  return JSON.parse(result.slice(marker.length));
}

const contextCode = context => `
const entry=(await listTaskSpaces()).find(s=>s.id===${JSON.stringify(context.spaceId)});
if(!entry||entry.ownership!=='agent')throw new Error('任务空间消失或控制权已改变');
const task = await taskSpace(${JSON.stringify(context.spaceId)});
if(task.ownership!=='agent') throw new Error('浏览器控制权已改变，停止采集');
const tab=(await task.tabs()).find(t=>t.label===${JSON.stringify(context.page)});
if(!tab || tab.targetId!==${JSON.stringify(context.targetId)} || tab.url!==${JSON.stringify(context.expectedUrl)})
 throw new Error('浏览器目标或地址已改变，停止采集');
const page=task.page(${JSON.stringify(context.page)});
`;

export async function openBrowser({ runId, egoBin, signal } = {}) {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(runId || '')) throw new Error('缺少独立浏览器 runId');
  return execute(`const task=await taskSpace(${JSON.stringify('原话卡片-' + runId)});
const page=task.page('p1');const tab=(await task.tabs()).find(t=>t.label==='p1');
console.log('${marker}'+JSON.stringify({spaceId:task.spaceId,page:'p1',targetId:tab.targetId,expectedUrl:tab.url,runId:${JSON.stringify(runId)}}));`, { egoBin, signal });
}

export async function acquireEpisode(context, bvid, outDir, options = {}) {
  if (!BVID.test(bvid)) throw new Error('无效 BV 号');
  await mkdir(outDir, { recursive: true });
  const canonical = `https://www.bilibili.com/video/${bvid}/`;
  const prior = new URL(context.expectedUrl);
  const observedSource = context.bilibiliSource || (prior.hostname === 'www.bilibili.com' ? prior.searchParams.get('vd_source') : null);
  // Carry only a previously observed tracking value through our own navigation.
  // Bilibili can otherwise append it late, correctly tripping URL isolation.
  const url = canonical + (typeof observedSource === 'string' && /^[a-f0-9]{32}$/.test(observedSource) ? '?vd_source=' + observedSource : '');
  const capture = options.happyCapture ? `
const cdp=(m,p)=>page.cdp(m,p),pageInfo=()=>page.evaluate(()=>({url:location.href,w:innerWidth,h:innerHeight}));
const currentTab=async()=>(await task.tabs()).find(t=>t.label===${JSON.stringify(context.page)});
const useOrCreateTaskSpace=async id=>({id:(await taskSpace(id)).spaceId});
const {captureVerifiedBrowserStep}=await import(${JSON.stringify('file://' + options.happyCapture.helperPath)});
const frame=await captureVerifiedBrowserStep({cdp,pageInfo,currentTab,listTaskSpaces,useOrCreateTaskSpace},expected,${JSON.stringify({ sessionId: options.happyCapture.sessionId, runId: context.runId, skillName: 'ego-browser', taskSpaceId: context.spaceId, targetId: context.targetId })});
browserStep={path:frame.path,label:'核对并采集新一期 '+${JSON.stringify(bvid)},runId:${JSON.stringify(context.runId)},skillName:'ego-browser'};
` : '';
  const result = await execute(contextCode(context) + `
await page.goto(${JSON.stringify(url)});
await page.waitForFunction(()=>window.__INITIAL_STATE__?.videoData && window.__playinfo__?.data?.dash && document.querySelector('video')?.readyState>=2,undefined,{timeout:45000});
const expected=${JSON.stringify(url)};
if(await page.url()!==expected)throw new Error('作品地址已改变，停止；需所有者核对新的浏览器上下文');
const actual=new URL(expected);
const selected=await page.evaluate(({bvid})=>{
 const s=window.__INITIAL_STATE__,d=s.videoData,p=window.__playinfo__.data;
 if(d.bvid!==bvid||!Number.isSafeInteger(d.owner.mid)||d.owner.mid<=0||s.p!==1||d.pages.length!==1)throw new Error('作品身份不匹配或多P尚未支持');
 if(d.duration>3600||d.duration<=0)throw new Error('仅支持60分钟以内的视频');
 for(const v of document.querySelectorAll('video')){v.pause();v.autoplay=false;}
 const resources=performance.getEntriesByType('resource').filter(e=>/\\.m4s(?:\\?|$)/.test(e.name));
 const key=u=>{const q=new URL(u);return q.hostname+q.pathname;};
 const choose=list=>{
  const candidates=list.map(x=>({x,urls:[x.baseUrl,x.base_url,...(x.backupUrl||x.backup_url||[])].filter(Boolean)}))
   .map(o=>({...o,loaded:resources.filter(e=>o.urls.some(u=>key(u)===key(e.name)))})).filter(o=>o.loaded.length);
  if(candidates.length!==1)throw new Error('播放器实际媒体候选不唯一');
  const {x,loaded,urls}=candidates[0];return {urls:[...new Set([...loaded.toReversed().map(e=>e.name),...urls])].slice(0,4),id:x.id,codecs:x.codecs,width:x.width,height:x.height};
 };
 const audio=choose(p.dash.audio),video=choose(p.dash.video);
 return {metadata:{bvid,title:d.title,author:d.owner.name,uid:d.owner.mid,cid:d.cid,page:1,source:'https://www.bilibili.com/video/'+bvid+'/',publishedAt:new Date(d.pubdate*1000).toISOString(),duration:d.duration,mediaDuration:p.timelength/1000,width:video.width,height:video.height,acquiredAt:new Date().toISOString()},audio,video};
},${JSON.stringify({ bvid })});
const fs=await import('node:fs/promises');
const verifiedContext={...${JSON.stringify(context)},expectedUrl:expected,...(actual.searchParams.has('vd_source')?{bilibiliSource:actual.searchParams.get('vd_source')}:{})};
await fs.writeFile(${JSON.stringify(join(outDir, 'browser-context.json'))},JSON.stringify(verifiedContext)+'\\n',{mode:0o600});
const fetchReceipt={};
const {downloadBrowserMedia}=await import(${JSON.stringify(new URL('./browser-media.mjs', import.meta.url).href)});
let remaining=512*1024*1024;
for(const type of ['audio','video']){
 let complete=false,attempts=0;
 for(const url of selected[type].urls){
  attempts++;
  try{const size=await downloadBrowserMedia(page,url,${JSON.stringify(outDir)}+'/'+type+'.m4s',remaining,expected);remaining-=size;complete=true;}catch(error){if(/上限|地址已改变|控制权/.test(error.message))throw error;/* Another address of the same verified player track only. */}
  if(await page.url()!==expected)throw new Error('下载期间作品发生变化');
  if(complete)break;
 }
 if(!complete)throw new Error(type+'媒体读取失败；本次播放器提供的地址均未完成');
 fetchReceipt[type]={id:selected[type].id,codecs:selected[type].codecs,attempts};
}
await fs.writeFile(${JSON.stringify(join(outDir, 'media-fetch.json'))},JSON.stringify(fetchReceipt)+'\\n',{flag:'wx',mode:0o600});
await fs.writeFile(${JSON.stringify(join(outDir, 'metadata.json'))},JSON.stringify(selected.metadata,null,2)+'\\n',{flag:'wx',mode:0o600});
let browserStep;${capture}
console.log('${marker}'+JSON.stringify({metadata:selected.metadata,context:verifiedContext,browserStep}));`, options);
  if((await stat(join(outDir,'audio.m4s'))).size+(await stat(join(outDir,'video.m4s'))).size>512*1024*1024)throw new Error('媒体超过512MiB上限');
  const files = {};
  for (const name of ['metadata.json', 'audio.m4s', 'video.m4s']) files[name] = await fingerprint(join(outDir, name));
  await writeJSON(join(outDir, 'acquisition.json'), { schemaVersion: 1, context: result.context, files });
  return result;
}

export async function finishBrowser(context, options = {}) {
  return execute(contextCode(context) + `await task.finish({keep:[]});console.log('${marker}'+JSON.stringify({finished:true}));`, options);
}
