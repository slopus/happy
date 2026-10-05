// Isolated reviewer probe. No network, database, browser, provider or product mutation.
// Run: node <absolute path to this file>
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const advisor='/Users/jacky/jacky-github/relationship-advisor--paws-services';
const require=createRequire(advisor+'/package.json');
const {createBrowserPersonalTransport,createMemoryServiceStorage}=await import(pathToFileURL(require.resolve('@wangjs-jacky/paws-agent/services/browser')).href);
const {createAdvisorJournal}=await import(pathToFileURL(advisor+'/public/ai-service.js').href);
const appId='relationship-advisor',binding={id:'binding',appId,serviceId:'service',revision:1,machineId:'machine',engine:'codex',accountRef:{kind:'codex-profile',id:'profile'},requestedModel:null,reasoning:{mode:'default'},permissions:['chat']};
const receipt={id:'grant',ownerId:'owner',kind:'personal-grant',protocol:'ai-services/1',scope:{appId,serviceId:'service',targets:[{machineId:'machine',engine:'codex',accountRef:{kind:'codex-profile',id:'profile'}}],permissions:['chat'],expiresAt:null},createdAt:1,revokedAt:null,credential:'paws_service.grant.'+'A'.repeat(43),messageKey:Buffer.alloc(32,7).toString('base64')};
const base=createMemoryServiceStorage();let reads=0,release;
const barrier=new Promise(resolve=>release=resolve);
// Preserve atomic putIfAbsent. Only arrange the valid concurrent absent-read order.
const storage={...base,async get(key){const value=await base.get(key);if(key.startsWith('outbox:')){if(++reads===2)release();await barrier;}return value;}};
let posts=0,accepted=0;
const transport=createBrowserPersonalTransport({appId,serverUrl:'https://paws.test',webUrl:'https://paws-web.test',origin:'https://app.test',storage,fetch:async(url,init)=>{
 if(String(url).endsWith('/turns')) {
  posts++;const {requestId}=JSON.parse(init.body);
  if(posts===1){accepted++;throw new TypeError('simulated response loss after acceptance');}
  return Response.json({error:{code:'authorization-revoked',retryable:false,submission:'not-submitted',requestId}},{status:409});
 }
 return Response.json({services:[{id:'service',ownerId:'owner',name:'test',enabled:true,revision:1}],app:{appId,name:'Advisor',origins:['https://app.test'],capabilities:['chat'],businessPrompt:{id:'prompt',version:'1'}}});
}});
await transport.authorize({receipt});
const journal=createAdvisorJournal({storage,request:()=>{throw Error('no application host');}});
await journal.save('personal',{id:'conversation',binding});
await journal.prepareTurn('personal','conversation',[{role:'user',text:'hello'}]);
const client={turns:{start:input=>transport.start(input)}};
const results=await Promise.allSettled([journal.start('personal','conversation',client),journal.start('personal','conversation',client)]);
console.log(JSON.stringify({posts,accepted,results:results.map(r=>({code:r.reason?.code,submission:r.reason?.submission})),pending:(await journal.get('personal','conversation')).pending}));
transport.dispose();
