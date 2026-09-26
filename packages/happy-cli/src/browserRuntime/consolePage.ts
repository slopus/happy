/**
 * Client console served at GET /console: find the principal's open tasks on the
 * capability's profile, watch a task's events, answer approvals, take/release
 * control, resume/stop, and open the live screen through the Runtime viewer.
 * Vanilla JS, no external assets.
 *
 * Capability hand-off (D12): Desktop opens `/console#abp-cap=<abp2 token>&abp-exp=<ms>`.
 * The page reads the fragment once, removes it from the address and keeps the
 * token in memory only. About a minute before expiry it asks its host with
 * `postMessage({ type: 'abp-capability-request' }, location.origin)` (every 10 s
 * until answered) and accepts `{ type: 'abp-capability', token, expiresAtMs }`
 * only from `window.parent` on its own origin. Desktop hosts the page in a
 * `<webview>` without preload, so `window.parent === window` and the answer is
 * posted into the page by the host. A load without a fragment (reload, back
 * navigation, restored panel) asks the host at once and every 10 s until answered;
 * in the harness the token can also be pasted, still kept in memory only. An open
 * screen is reconnected with a fresh ticket after each renewal (a viewer connection
 * ends with the capability it was ticketed with). Take over/release use the selected
 * tab's own lease epoch from getTask().tabLeases.
 */
export function renderConsolePage(): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser Task Console</title>
<style>
:root{--bg:#fff;--fg:#1b1b1f;--muted:#666;--line:#ddd;--accent:#2b59c3;--warn:#b25b00}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e8e8ea;--muted:#9a9aa2;--line:#33343a;--accent:#7aa2ff;--warn:#f0a050}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1100px}
input{width:100%;box-sizing:border-box;padding:6px;margin:2px 0 8px;background:var(--bg);color:var(--fg);border:1px solid var(--line)}
button{margin:2px 4px 2px 0;padding:6px 10px;border:1px solid var(--line);background:var(--bg);color:var(--accent);cursor:pointer}
section{border:1px solid var(--line);padding:10px;margin:10px 0}pre{white-space:pre-wrap;word-break:break-word;margin:0}
.muted{color:var(--muted)}.warn{color:var(--warn)}#events{max-height:320px;overflow:auto}
#tasks button{display:block;width:100%;text-align:left}#screen{width:100%;height:70vh;border:1px solid var(--line)}
</style></head><body>
<h1>Browser task console</h1>
<section id="auth"><span id="capState" class="muted">no capability</span>
<details id="manual"><summary>Paste a capability token</summary><input id="token" type="password" autocomplete="off"><button id="useToken">Use token</button></details></section>
<section><h2>Tasks</h2><button id="refreshTasks">Refresh</button><div id="tasks" class="muted">not connected</div>
<label>Task id<input id="taskId" autocomplete="off"></label><label>Tab id (for take over / release)<input id="tabId" autocomplete="off"></label>
<button id="connect">Watch task</button><span id="conn" class="muted"></span></section>
<section><h2>Task</h2><pre id="task" class="muted">not connected</pre></section>
<section id="approvalBox" hidden><h2 class="warn">Approval required</h2><pre id="approval"></pre>
<button id="approve">Approve</button><button id="reject">Reject</button></section>
<section><h2>Control</h2><button id="takeOver">Take over</button><button id="release">Release</button>
<button id="resume">Resume</button><button id="stop">Stop</button><pre id="actionResult" class="muted"></pre></section>
<section><h2>Screen</h2><button id="openScreen">Open screen</button><span class="muted"> input reaches the page only while you hold take over</span>
<div id="screenBox" hidden><iframe id="screen" title="Browser screen" referrerpolicy="no-referrer"></iframe></div></section>
<section><h2>Events</h2><pre id="events"></pre></section>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var S={cursor:0,seen:{},task:null,gen:0,token:'',expiresAtMs:0,profileId:'',renewTimer:0,screenOpen:false};
var RENEW_BEFORE_MS=60000,RENEW_RETRY_MS=10000;
function rid(){return (crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random())}
function decodePart(p){try{return JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')))}catch(e){return null}}
function askHost(){clearTimeout(S.renewTimer);window.parent.postMessage({type:'abp-capability-request'},location.origin);S.renewTimer=setTimeout(askHost,RENEW_RETRY_MS)}
function setCapability(token,expiresAtMs){var renewal=!!S.token;
 var parts=String(token||'').split('.');var payload=parts.length>=3?decodePart(parts[parts.length===4?2:1]):null;
 if(!payload||typeof payload.profileId!=='string'){$('capState').textContent='capability is not readable';return false}
 S.token=token;S.profileId=payload.profileId;S.expiresAtMs=Number(expiresAtMs)||Number(payload.expiresAtMs)||0;
 $('capState').textContent='profile '+S.profileId+(S.expiresAtMs?' · expires '+new Date(S.expiresAtMs).toLocaleTimeString():'');
 scheduleRenewal();if(renewal&&S.screenOpen)openScreen();return true}
function scheduleRenewal(){clearTimeout(S.renewTimer);if(!S.expiresAtMs)return;
 var wait=Math.max(0,S.expiresAtMs-RENEW_BEFORE_MS-Date.now());
 S.renewTimer=setTimeout(askHost,wait)}
window.addEventListener('message',function(event){
 if(event.source!==window.parent||event.origin!==location.origin)return;
 var d=event.data;if(!d||d.type!=='abp-capability'||typeof d.token!=='string'||typeof d.expiresAtMs!=='number')return;
 var first=!S.token;if(setCapability(d.token,d.expiresAtMs)&&first)listTasks()});
(function readFragment(){var h=location.hash.replace(/^#/,'');if(!h)return;var q=new URLSearchParams(h);
 var token=q.get('abp-cap');if(token)setCapability(token,Number(q.get('abp-exp')));
 history.replaceState(null,'',location.pathname+location.search)})();
function op(name,body){return fetch('/v1/ops/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+S.token},body:JSON.stringify(body)})
 .then(function(r){return r.json()}).then(function(j){if(!j.ok){var e=new Error(j.error.code+': '+j.error.message);e.body=j.error;throw e}return j.result})}
function showTask(t){S.task=t;$('task').textContent=JSON.stringify({status:t.status,pauseReason:t.pauseReason,waitReason:t.waitReason,stateVersion:t.stateVersion,tabs:t.tabs,cancelRequested:t.cancelRequested,uncertainActions:t.uncertainActions},null,2);
 if(!$('tabId').value&&t.tabs&&t.tabs[0])$('tabId').value=t.tabs[0];
 var a=t.pendingApproval;$('approvalBox').hidden=!a;if(a)$('approval').textContent='origin: '+a.origin+'\\n'+a.description+'\\nexpires: '+new Date(a.expiresAtMs).toLocaleString()}
function listTasks(){if(!S.token)return;$('tasks').textContent='loading';
 op('listTasks',{profileId:S.profileId}).then(function(r){var box=$('tasks');box.textContent='';box.className='';
  if(!r.tasks.length){box.textContent='no open tasks';box.className='muted';return}
  r.tasks.forEach(function(t){var b=document.createElement('button');b.type='button';
   b.textContent=t.taskId+' · '+t.status+(t.pauseReason?'/'+t.pauseReason:'')+(t.pendingApproval?' · approval':'')+' · '+new Date(t.updatedAtMs).toLocaleTimeString();
   b.onclick=function(){$('taskId').value=t.taskId;$('tabId').value=(t.tabs&&t.tabs[0])||'';watch()};box.appendChild(b)})
 },function(e){$('tasks').textContent=e.message;$('tasks').className='warn'})}
/** The Runtime checks the selected tab's own lease epoch, not a global maximum. */
function tabEpoch(){var tab=$('tabId').value.trim();var leases=(S.task&&S.task.tabLeases)||[];for(var i=0;i<leases.length;i++)if(leases[i].tabId===tab)return leases[i].leaseEpoch;return 0}
function addEvent(e){if(S.seen[e.seq])return;S.seen[e.seq]=1;if(e.seq>S.cursor)S.cursor=e.seq;
 var line=document.createElement('div');line.textContent='#'+e.seq+' '+e.type+' '+JSON.stringify(e.data);$('events').prepend(line)}
function refresh(){return op('getTask',{taskId:$('taskId').value.trim()}).then(showTask)}
function loop(gen){if(gen!==S.gen)return;
 op('subscribe',{taskId:$('taskId').value.trim(),afterSeq:S.cursor,waitMs:25000}).then(function(r){
  if(gen!==S.gen)return;$('conn').textContent=' connected';
  if(r.kind==='snapshot-required'){S.cursor=r.highWatermarkSeq;S.seen={};showTask(r.snapshot)}
  else if(r.events.length){r.events.forEach(addEvent);return refresh()}
 }).then(function(){loop(gen)},function(e){$('conn').textContent=' '+e.message+' (retrying)';setTimeout(function(){loop(gen)},2000)})}
function watch(){S.cursor=0;S.seen={};$('events').textContent='';var gen=++S.gen;refresh().then(function(){loop(gen)},function(e){$('conn').textContent=' '+e.message})}
$('useToken').onclick=function(){if(setCapability($('token').value.trim()))listTasks();$('token').value=''};
$('refreshTasks').onclick=listTasks;$('connect').onclick=watch;
function act(p){$('actionResult').textContent='...';p.then(function(r){$('actionResult').textContent=JSON.stringify(r.status||r.outcome||r.owner||r,null,0);if(r.task)showTask(r.task);return refresh()})
 .catch(function(e){$('actionResult').textContent=e.message;if(e.body&&e.body.code==='STALE_LEASE')refresh()})}
function decide(d){var a=S.task&&S.task.pendingApproval;if(!a)return;act(op('approve',{taskId:S.task.taskId,approvalId:a.approvalId,bindingHash:a.bindingHash,requestId:rid(),decision:d}))}
$('approve').onclick=function(){decide('approve')};$('reject').onclick=function(){decide('reject')};
$('takeOver').onclick=function(){act(op('takeOver',{taskId:$('taskId').value.trim(),tabId:$('tabId').value.trim(),expectedEpoch:tabEpoch(),requestId:rid()}))};
$('release').onclick=function(){act(op('releaseControl',{taskId:$('taskId').value.trim(),tabId:$('tabId').value.trim(),expectedEpoch:tabEpoch(),requestId:rid()}))};
$('resume').onclick=function(){if(S.task)act(op('resume',{taskId:S.task.taskId,expectedVersion:S.task.stateVersion,requestId:rid()}))};
$('stop').onclick=function(){act(op('cancel',{taskId:$('taskId').value.trim(),requestId:rid()}))};
/** A viewer connection is bound to the capability it was ticketed with: renewal reconnects it. */
function openScreen(){op('viewerTicket',{profileId:S.profileId}).then(function(r){S.screenOpen=true;
 $('screen').src='/viewer/vnc_lite.html?path='+encodeURIComponent('v1/viewer/websockify?ticket='+encodeURIComponent(r.ticket));$('screenBox').hidden=false
},function(e){$('actionResult').textContent=e.message})}
$('openScreen').onclick=openScreen;
// Reload, back navigation or a restored panel arrive without a fragment: ask the host now.
if(S.token)listTasks();else askHost();
})();
</script></body></html>`
}
