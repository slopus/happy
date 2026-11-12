// Same owned Ego target throughout emulation, native input and layout readback.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const config=globalThis.pinnedItemsConfig;
const runtime=JSON.parse(await fs.readFile(config.runtimePath,'utf8'));
const context=JSON.parse(await fs.readFile(config.contextPath,'utf8'));
await useOrCreateTaskSpace(context.taskSpaceId);
const expected=runtime.webUrl+'/projects?machine='+encodeURIComponent(runtime.machineId);
assert.equal((await currentTab()).targetId,context.targetId);assert.equal((await currentTab()).url,expected);
const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
const point=selector=>evaluate(`JSON.stringify((()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})())`).then(JSON.parse);
const click=async selector=>{const p=await point(selector);await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await settle();};
// Search is shared by the top favorites and the main library.
await click('input[placeholder="Search projects or tasks"]');
await cdp('Input.insertText',{text:'产品方案'});await settle();
assert.equal(await evaluate('document.querySelectorAll("[data-testid=project-favorites-section] [data-testid^=saved-item-]").length'),1);
assert.equal(await evaluate('document.querySelectorAll("[data-testid=project-library-main] [data-testid^=project-cover-]").length'),0);
await evaluate(`(()=>{const n=document.querySelector('input[placeholder="Search projects or tasks"]');n.focus();n.select();})()`);
await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await settle();
assert.equal(await evaluate('document.querySelectorAll("[data-testid=project-favorites-section] [data-testid^=saved-item-]").length'),5);
const frames=[],layouts=[];
for(const [width,height,columns] of [[1680,885,5],[1366,768,4],[390,844,1]]){
 await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false,dontSetVisibleSize:true});await settle();
 await evaluate('(()=>{const n=document.querySelector("[data-testid=project-favorites-section]");for(let p=n.parentElement;p;p=p.parentElement)if(p.scrollHeight>p.clientHeight+1){p.scrollTop=0;break;}})()');await settle();
 const value=JSON.parse(await evaluate('JSON.stringify((()=>{const f=document.querySelector("[data-testid=project-favorites-section]"),g=f.querySelector("[data-testid=project-saved-items]"),m=document.querySelector("[data-testid=project-library-main] [data-testid=project-cover-0]");return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth,favoritesHeight:f.getBoundingClientRect().height,favoriteColumns:getComputedStyle(g).gridTemplateColumns.split(" ").length,mainCardTop:m.getBoundingClientRect().top,mainColumns:getComputedStyle(document.querySelector("[data-testid=project-library-main] [data-testid=project-gallery]")).gridTemplateColumns.split(" ").length,actionsInside:[...f.querySelectorAll("button")].every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})}})())'));
 assert.equal(value.width,width);assert.equal(value.favoriteColumns,columns);assert.equal(value.mainColumns,columns);assert(value.overflow<=1);assert(value.actionsInside);
 if(width>=1100){assert(value.favoritesHeight<240);assert(value.mainCardTop<height-100);}
 layouts.push(value);
 if(width!==1680){const {captureVerifiedBrowserStep}=await import('file:///Users/jacky/Deployments/paws-cli/releases/project-task-flow-candidate-20261112/packages/happy-cli/scripts/capture-browser-step.mjs');const f=await captureVerifiedBrowserStep({cdp,pageInfo,currentTab,listTaskSpaces,useOrCreateTaskSpace},expected,context);frames.push({...f,label:width===1366?'四列紧凑收藏与资料库同屏可见':'窄屏收藏与操作无横向溢出'});}
}
await cdp('Emulation.setDeviceMetricsOverride',{width:1680,height:885,deviceScaleFactor:1,mobile:false,dontSetVisibleSize:true});await settle();
const button='[data-testid="project-library-main"] [data-testid="project-favorite-0"]';
const color=selector=>evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`);
await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:130});await settle();const resting=await color(button);
await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...(await point(button))});await settle();const hovered=await color(button);
const selected=await color('[data-testid="project-favorites-section"] [data-testid^="library-favorite-"]');
assert.notEqual(resting,hovered);assert.notEqual(selected,resting);
await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:130});await settle();
const {captureVerifiedBrowserStep}=await import('file:///Users/jacky/Deployments/paws-cli/releases/project-task-flow-candidate-20261112/packages/happy-cli/scripts/capture-browser-step.mjs');
frames.push({...await captureVerifiedBrowserStep({cdp,pageInfo,currentTab,listTaskSpaces,useOrCreateTaskSpace},expected,context),label:'深色主题下五类收藏紧凑置顶，资料库首屏可见'});
await fs.writeFile(path.join(path.dirname(config.runtimePath),'pinned-layouts.json'),JSON.stringify({layouts,theme:{resting,hovered,selected},search:true,frames},null,2));
console.log({id:'PF5',status:'pass',layouts,theme:{resting,hovered,selected}});
await cdp('Emulation.clearDeviceMetricsOverride',{});
