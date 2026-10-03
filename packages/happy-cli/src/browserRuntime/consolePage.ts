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
 *
 * Studio web opens the page in a new window through its preview relay, which
 * strips the URL (fragment included) on load. There the host is `window.opener`
 * on the Studio origin: requests go to it addressed to each configured
 * `hostOrigins` entry (so another opener never hears them), and an answer is
 * accepted only from `window.opener` on one of those origins.
 *
 * Look and language follow Saycode Studio: its colour tokens (light and dark by the system scheme) and
 * Korean or English by `?lang=` or the browser language. The element ids and the task list layout
 * (`#tasks > button` for tasks waiting for the user, the rest folded in `#tasks details`) are part of the
 * contract the real-Chrome tests drive.
 */
export function renderConsolePage(opts: { hostOrigins?: readonly string[] } = {}): string {
    // JSON in an inline script: escape '<' so an origin can never close the tag.
    const hostOrigins = JSON.stringify(opts.hostOrigins ?? []).replace(/</g, '\\u003c')
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Browser</title>
<style>
:root{--bg:#f6f6f7;--card:#fff;--fg:#09090b;--muted:#52525b;--soft:#ebebec;--line:#dcdce0;--primary:#1B64DA;--primary-fg:#fff;
--warn-bg:#fef4e4;--warn-line:#fbdaa4;--warn:#b45309;--ok:#047857;--ok-bg:#e7f7f0;--danger:#dc2626;--radius:14px;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#13161a;--card:#22252c;--fg:#fafafa;--muted:#a1a1aa;--soft:#272932;--line:#3e424d;--primary:#2470E4;
--warn-bg:#4a3f2e;--warn-line:rgba(251,191,36,.36);--warn:#fbbf24;--ok:#6ee7b7;--ok-bg:rgba(16,185,129,.14);--danger:#f87171;color-scheme:dark}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:14px/1.5 Pretendard,Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0}
svg{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2}
header h1{flex:none;font-size:15px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px}
header h1 svg{color:var(--primary);width:18px;height:18px}
.pill{min-width:0;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);background:var(--soft);border-radius:999px;padding:3px 10px;white-space:nowrap}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--muted)}
.pill.on i{background:#10b981}.pill.bad{color:var(--danger)}.pill.bad i{background:var(--danger)}
.spacer{flex:1}
main{display:grid;grid-template-columns:minmax(260px,320px) 1fr;gap:16px;padding:16px 20px;max-width:1280px;margin:0 auto}
main>*{min-width:0}
@media (max-width:860px){main{grid-template-columns:1fr;padding:12px}header{padding:12px}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px}
.card+.card,.col>*+*,#detail>*+*{margin-top:12px}
.col>[hidden]+*{margin-top:0}
.card h2{font-size:13px;font-weight:600;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.card h2 svg{color:var(--muted)}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.head h2{margin:0}
.muted{color:var(--muted)}.small{font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
button{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 12px;border-radius:10px;
border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap}
button:hover{background:var(--soft)}button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}button.primary:hover{filter:brightness(1.08)}
button.danger{color:var(--danger)}button.icon{width:30px;height:30px;padding:0;border-color:transparent;background:transparent;color:var(--muted)}
button.icon:hover{background:var(--soft);color:var(--fg)}
.row{display:flex;flex-wrap:wrap;gap:8px}
input{font:inherit;width:100%;height:34px;padding:0 10px;margin:4px 0 10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
label{font-size:12px;color:var(--muted)}
#tasks{display:flex;flex-direction:column;gap:6px}
#tasks button{display:block;width:100%;height:auto;text-align:left;padding:10px 12px;border-radius:12px;line-height:1.35}
#tasks button.sel{border-color:var(--primary);box-shadow:0 0 0 1px var(--primary) inset}
#tasks button .tid{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
#tasks button .what{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;font-size:13px;font-weight:500}
#tasks button .when{font-size:11px;color:var(--muted);font-weight:400}
#tasks details{margin-top:4px}#tasks summary{cursor:pointer;font-size:12px;color:var(--muted);padding:6px 2px;list-style:none}
#tasks summary::before{content:"\\203A";display:inline-block;margin-right:6px;transition:transform .15s}#tasks details[open] summary::before{transform:rotate(90deg)}
#tasks details button{margin-top:6px}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--soft);color:var(--muted);white-space:nowrap}
.chip.warn{background:var(--warn-bg);color:var(--warn)}.chip.run{background:rgba(27,100,218,.12);color:var(--primary)}.chip.ok{background:var(--ok-bg);color:var(--ok)}
.empty{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:28px 12px;color:var(--muted)}
.empty svg{width:28px;height:28px;color:var(--muted);opacity:.7}
.empty b{color:var(--fg);font-weight:600}
.warn-text{color:var(--danger)}
.title{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.title h2{font-size:16px;margin:0}
.reason{margin:6px 0 0;color:var(--muted)}
#approvalBox{border-color:var(--warn-line);background:var(--warn-bg)}
#approvalBox h2{color:var(--warn)}#approvalBox h2 svg{color:var(--warn)}
#approval{margin:0 0 12px}#approval .desc{font-size:14px;font-weight:500;color:var(--fg);white-space:pre-wrap;word-break:break-word}
#approval .meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12px;color:var(--muted)}
.hint{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--muted);margin-top:10px}
#actionResult:empty{display:none}#actionResult{margin-top:10px;font-size:12px;padding:8px 10px;border-radius:10px;background:var(--soft)}
#actionResult.err{color:var(--danger)}
#screenBox{margin-top:12px}
#screen{width:100%;aspect-ratio:16/10;min-height:360px;border:1px solid var(--line);border-radius:12px;background:#000;display:block}
details.fold>summary{cursor:pointer;font-size:13px;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px}
details.fold>summary::after{content:"\\203A";margin-left:auto;color:var(--muted);transition:transform .15s}details.fold[open]>summary::after{transform:rotate(90deg)}
details.fold>summary svg{color:var(--muted)}
details.fold[open]>summary{margin-bottom:10px}
#events{max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:4px}
#events div{display:flex;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px dashed var(--line)}
#events .t{color:var(--muted);flex:none}#events .k{font-weight:600;flex:none}#events .d{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--soft);padding:10px;border-radius:10px}
#detail[hidden],#placeholder[hidden]{display:none}
summary::-webkit-details-marker{display:none}
</style></head><body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></symbol>
<symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/></symbol>
<symbol id="i-hand" viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></symbol>
<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></symbol>
<symbol id="i-activity" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></symbol>
<symbol id="i-settings" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-inbox" viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></symbol>
</defs></svg>
<header><h1><svg aria-hidden="true"><use href="#i-globe"/></svg><span data-t="title">Agent Browser</span></h1><span class="spacer"></span>
<span id="capState" class="pill"><i></i><span>not connected</span></span></header>
<main>
<aside>
<section class="card"><div class="head"><h2><svg aria-hidden="true"><use href="#i-list"/></svg><span data-t="tasks">Tasks</span></h2>
<button id="refreshTasks" class="icon" type="button" data-tt="refresh" title="Refresh"><svg aria-hidden="true"><use href="#i-refresh"/></svg></button></div>
<div id="tasks" class="muted">not connected</div></section>
<section class="card"><details class="fold" id="advanced"><summary><svg aria-hidden="true"><use href="#i-settings"/></svg><span data-t="advanced">Advanced</span></summary>
<label><span data-t="taskId">Task id</span><input id="taskId" autocomplete="off"></label>
<label><span data-t="tabId">Tab id (for take over / release)</span><input id="tabId" autocomplete="off"></label>
<div class="row"><button id="connect" type="button" data-t="watch">Watch task</button><span id="conn" class="muted small"></span></div>
<div id="manual" style="margin-top:12px"><label><span data-t="paste">Paste a capability token</span><input id="token" type="password" autocomplete="off"></label>
<button id="useToken" type="button" data-t="useToken">Use token</button></div>
<div style="margin-top:12px"><label data-t="rawTask">Task details</label><pre id="task" class="muted">not connected</pre></div>
</details></section>
</aside>
<div class="col">
<section class="card" id="placeholder"><div class="empty"><svg aria-hidden="true"><use href="#i-inbox"/></svg><b data-t="pickTitle">Pick a task</b><span data-t="pickBody">Tasks that need you appear on the left.</span></div></section>
<div id="detail" hidden>
<section class="card"><div class="title"><h2 id="detailTitle"></h2></div>
<p id="detailReason" class="reason"></p><p class="mono muted" id="detailId" style="margin:6px 0 0"></p></section>
<section class="card" id="approvalBox" hidden><h2><svg aria-hidden="true"><use href="#i-shield"/></svg><span data-t="approvalTitle">Approval required</span></h2>
<div id="approval"></div>
<div class="row"><button id="approve" class="primary" type="button" data-t="approve">Approve</button><button id="reject" type="button" data-t="reject">Reject</button></div></section>
<section class="card"><h2><svg aria-hidden="true"><use href="#i-hand"/></svg><span data-t="control">Control</span></h2>
<div class="row"><button id="takeOver" class="primary" type="button" data-t="takeOver">Take over</button><button id="release" type="button" data-t="release">Release</button>
<button id="resume" type="button" data-t="resume">Resume</button><button id="stop" class="danger" type="button" data-t="stop">Stop</button></div>
<div class="hint"><svg aria-hidden="true"><use href="#i-info"/></svg><span data-t="controlHint">Take over to use the page yourself (login, verification). Release it and the agent continues.</span></div>
<div id="actionResult"></div></section>
</div>
<section class="card"><div class="head"><h2><svg aria-hidden="true"><use href="#i-monitor"/></svg><span data-t="screen">Screen</span></h2>
<button id="openScreen" type="button" data-t="openScreen">Open screen</button></div>
<p class="muted small" style="margin:0" data-t="screenHint">input reaches the page only while you hold take over</p>
<div id="screenBox" hidden><iframe id="screen" title="Browser screen" referrerpolicy="no-referrer"></iframe></div></section>
<section class="card"><details class="fold"><summary><svg aria-hidden="true"><use href="#i-activity"/></svg><span data-t="events">Activity</span></summary><div id="events"></div></details></section>
</div>
</main>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var S={cursor:0,seen:{},task:null,gen:0,token:'',expiresAtMs:0,profileId:'',renewTimer:0,screenOpen:false,screenSeq:0};
var RENEW_BEFORE_MS=60000,RENEW_RETRY_MS=10000,HOST_ORIGINS=${hostOrigins};
var LANG=(new URLSearchParams(location.search).get('lang')||navigator.language||'en').toLowerCase().indexOf('ko')===0?'ko':'en';
var M={en:{title:'Agent Browser',tasks:'Tasks',refresh:'Refresh',advanced:'Advanced',taskId:'Task id',tabId:'Tab id (for take over / release)',watch:'Watch task',
 paste:'Paste a capability token',useToken:'Use token',rawTask:'Task details',pickTitle:'Pick a task',pickBody:'Tasks that need you appear on the left.',
 approvalTitle:'Approval required',approve:'Approve',reject:'Reject',control:'Control',takeOver:'Take over',release:'Release',resume:'Resume',stop:'Stop',
 controlHint:'Take over to use the page yourself (login, verification). Release it and the agent continues.',screen:'Screen',openScreen:'Open screen',
 screenHint:'input reaches the page only while you hold take over',events:'Activity',
 notConnected:'not connected',waitingHost:'Waiting for Saycode',connected:'Connected',until:'until',unreadable:'capability is not readable',loading:'loading',
 noTasksTitle:'Nothing needs you',noTasks:'no open tasks',others:function(n){return n+' other open task'+(n>1?'s':'')},live:'live',retrying:'retrying',
 needApproval:'Needs your approval',needLogin:'Login needed',needCaptcha:'Human verification needed',needHandoff:'Waiting for you',userControl:'You have control',
 running:'Running',paused:'Paused',awaitingUser:'Needs you',awaitingAgent:'Waiting for the agent',released:'Released',
 rLogin:'Take over, sign in on the screen, then release.',rCaptcha:'Take over and complete the verification on the screen, then release.',
 rHandoff:'The agent handed the page to you. Take over to continue.',rApproval:'The agent wants to do something that needs your approval.',
 rControl:'Your input reaches the page. Release when you are done so the agent continues.',rRunning:'The agent is working on it.',
 rReleased:'Resume to hand the page back to the agent, or wait for it to continue.',
 origin:'Site',expires:'Expires',ok:'Done'},
 ko:{title:'에이전트 브라우저',tasks:'작업',refresh:'새로고침',advanced:'고급',taskId:'작업 ID',tabId:'탭 ID (제어권 가져오기/반납용)',watch:'작업 보기',
 paste:'권한 토큰 붙여넣기',useToken:'토큰 사용',rawTask:'작업 상세',pickTitle:'작업을 고르세요',pickBody:'확인이 필요한 작업이 왼쪽에 나타나요.',
 approvalTitle:'승인이 필요해요',approve:'승인',reject:'거절',control:'제어',takeOver:'제어권 가져오기',release:'제어권 반납',resume:'계속 진행',stop:'작업 중지',
 controlHint:'로그인이나 사람 확인처럼 직접 해야 할 때 제어권을 가져오세요. 반납하면 에이전트가 이어서 진행해요.',screen:'화면',openScreen:'화면 보기',
 screenHint:'제어권을 가진 동안에만 입력이 화면에 전달돼요.',events:'활동 기록',
 notConnected:'연결 안 됨',waitingHost:'Saycode 연결 대기 중',connected:'연결됨',until:'까지',unreadable:'권한을 읽을 수 없어요',loading:'불러오는 중',
 noTasksTitle:'지금 확인할 작업이 없어요',noTasks:'열린 작업이 없어요',others:function(n){return '다른 작업 '+n+'개'},live:'실시간 연결됨',retrying:'다시 시도 중',
 needApproval:'승인 필요',needLogin:'로그인 필요',needCaptcha:'사람 확인 필요',needHandoff:'직접 조작 대기',userControl:'내가 제어 중',
 running:'진행 중',paused:'일시 정지',awaitingUser:'확인 필요',awaitingAgent:'에이전트 대기',released:'제어권 반납됨',
 rLogin:'제어권을 가져와 화면에서 로그인한 뒤 반납하세요.',rCaptcha:'제어권을 가져와 화면에서 확인을 마친 뒤 반납하세요.',
 rHandoff:'에이전트가 화면을 넘겼어요. 제어권을 가져와 이어서 진행하세요.',rApproval:'에이전트가 승인이 필요한 작업을 하려고 해요.',
 rControl:'입력이 화면에 전달되고 있어요. 다 하면 반납해야 에이전트가 이어서 진행해요.',rRunning:'에이전트가 작업하고 있어요.',
 rReleased:'계속 진행을 눌러 에이전트에게 넘기거나, 에이전트가 이어서 진행하기를 기다리세요.',
 origin:'사이트',expires:'만료',ok:'완료했어요'}};
var T=M[LANG];document.documentElement.lang=LANG;
document.querySelectorAll('[data-t]').forEach(function(el){var v=T[el.getAttribute('data-t')];if(typeof v==='string')el.textContent=v});
document.querySelectorAll('[data-tt]').forEach(function(el){var v=T[el.getAttribute('data-tt')];if(typeof v==='string'){el.title=v;el.setAttribute('aria-label',v)}});
document.title=T.title;
function capPill(text,cls){var p=$('capState');p.className='pill'+(cls?' '+cls:'');p.lastChild.textContent=text}
capPill(T.notConnected);$('tasks').textContent=T.notConnected;$('task').textContent=T.notConnected;
function rid(){return (crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random())}
function decodePart(p){try{return JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')))}catch(e){return null}}
function askHost(){clearTimeout(S.renewTimer);window.parent.postMessage({type:'abp-capability-request'},location.origin);
 if(window.opener)HOST_ORIGINS.forEach(function(o){try{window.opener.postMessage({type:'abp-capability-request'},o)}catch(e){}});
 if(!S.token)capPill(T.waitingHost);
 S.renewTimer=setTimeout(askHost,RENEW_RETRY_MS)}
function fromHost(event){return (event.source===window.parent&&event.origin===location.origin)
 ||(!!window.opener&&event.source===window.opener&&HOST_ORIGINS.indexOf(event.origin)>=0)}
function hhmm(ms){var d=new Date(ms);return isFinite(d.getTime())?d.toLocaleTimeString(LANG==='ko'?'ko-KR':'en-US',{hour:'2-digit',minute:'2-digit'}):''}
function setCapability(token,expiresAtMs){var renewal=!!S.token;
 var parts=String(token||'').split('.');var payload=parts.length>=3?decodePart(parts[parts.length===4?2:1]):null;
 if(!payload||typeof payload.profileId!=='string'){capPill(T.unreadable,'bad');return false}
 S.token=token;S.profileId=payload.profileId;S.expiresAtMs=Number(expiresAtMs)||Number(payload.expiresAtMs)||0;
 capPill(T.connected+(S.expiresAtMs?' · '+(LANG==='ko'?hhmm(S.expiresAtMs)+' '+T.until:T.until+' '+hhmm(S.expiresAtMs)):''),'on');
 $('capState').title='profile '+S.profileId;
 scheduleRenewal();if(renewal&&S.screenOpen)openScreen();return true}
function scheduleRenewal(){clearTimeout(S.renewTimer);if(!S.expiresAtMs)return;
 var wait=Math.max(0,S.expiresAtMs-RENEW_BEFORE_MS-Date.now());
 S.renewTimer=setTimeout(askHost,wait)}
window.addEventListener('message',function(event){
 if(!fromHost(event))return;
 var d=event.data;if(!d||d.type!=='abp-capability'||typeof d.token!=='string'||typeof d.expiresAtMs!=='number')return;
 var first=!S.token;if(setCapability(d.token,d.expiresAtMs)&&first)listTasks()});
/** The fragment is read on load and again on a later change (the host reopens the same page with a new capability). */
function readFragment(){var h=location.hash.replace(/^#/,'');if(!h)return false;var q=new URLSearchParams(h);
 var token=q.get('abp-cap'),used=!!token&&token!==S.token&&setCapability(token,Number(q.get('abp-exp')));
 history.replaceState(null,'',location.pathname+location.search);return used}
readFragment();
window.addEventListener('hashchange',function(){if(readFragment())listTasks()});
function op(name,body){return fetch('/v1/ops/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+S.token},body:JSON.stringify(body)})
 .then(function(r){return r.json()}).then(function(j){if(!j.ok){var e=new Error(j.error.code+': '+j.error.message);e.body=j.error;throw e}return j.result})}
/**
 * What the task is waiting for, in the user's words, and how loud to show it. The Runtime keeps
 * waitReason after the wait ends (released, expired), so it counts only while the user is still
 * awaited: the same rule as waitsForUser.
 */
function describe(t){
 if(t.pendingApproval&&!t.cancelRequested)return {label:T.needApproval,tone:'warn',reason:T.rApproval};
 if(t.pauseReason==='user-control')return {label:T.userControl,tone:'ok',reason:T.rControl};
 if(t.pauseReason==='user-input-complete')return {label:T.released,tone:'ok',reason:T.rReleased};
 var waiting=t.status==='awaiting-user'||t.pauseReason==='grant-expired';
 if(waiting&&t.waitReason==='login')return {label:T.needLogin,tone:'warn',reason:T.rLogin};
 if(waiting&&t.waitReason==='captcha')return {label:T.needCaptcha,tone:'warn',reason:T.rCaptcha};
 if(waiting&&t.waitReason==='handoff')return {label:T.needHandoff,tone:'warn',reason:T.rHandoff};
 if(t.status==='awaiting-user')return {label:T.awaitingUser,tone:'warn',reason:''};
 if(t.status==='running')return {label:T.running,tone:'run',reason:T.rRunning};
 if(t.pauseReason==='awaiting-agent')return {label:T.awaitingAgent,tone:'',reason:''};
 if(t.status==='paused')return {label:T.paused,tone:'',reason:''};
 return {label:t.status||'',tone:'',reason:''}}
function chip(el,d){el.className='chip'+(d.tone?' '+d.tone:'');el.textContent=d.label}
function showTask(t){S.task=t;$('task').textContent=JSON.stringify({status:t.status,pauseReason:t.pauseReason,waitReason:t.waitReason,stateVersion:t.stateVersion,tabs:t.tabs,cancelRequested:t.cancelRequested,uncertainActions:t.uncertainActions},null,2);
 if(!$('tabId').value&&t.tabs&&t.tabs[0])$('tabId').value=t.tabs[0];
 var d=describe(t);$('placeholder').hidden=true;$('detail').hidden=false;
 $('detailTitle').textContent=d.label||t.taskId; $('detailReason').textContent=d.reason;$('detailReason').hidden=!d.reason;$('detailId').textContent=t.taskId;
 // The control a user is most likely to need next is the loud one.
 var holding=t.pauseReason==='user-control',released=t.pauseReason==='user-input-complete';
 $('takeOver').className=holding||released?'':'primary';$('release').className=holding?'primary':'';$('resume').className=released?'primary':'';
 markSelected(t.taskId);
 var a=t.pendingApproval;$('approvalBox').hidden=!a;if(a)renderApproval(a)}
function renderApproval(a){var box=$('approval');box.textContent='';var d=document.createElement('div');d.className='desc';d.textContent=a.description;
 var m=document.createElement('div');m.className='meta';var o=document.createElement('span');o.textContent=T.origin+' · '+a.origin;
 var x=document.createElement('span');x.textContent=T.expires+' · '+hhmm(a.expiresAtMs);m.appendChild(o);m.appendChild(x);box.appendChild(d);box.appendChild(m)}
function markSelected(id){Array.prototype.forEach.call(document.querySelectorAll('#tasks button'),function(b){b.classList.toggle('sel',b.getAttribute('data-task')===id)})}
function emptyState(box,title,body){box.textContent='';var e=document.createElement('div');e.className='empty';
 e.innerHTML='<svg aria-hidden="true"><use href="#i-inbox"/></svg>';var b=document.createElement('b');b.textContent=title;var s=document.createElement('span');s.textContent=body;
 e.appendChild(b);e.appendChild(s);box.appendChild(e)}
/** A task card. Its text starts with the task id (the tests read it that way). */
function taskButton(t){var b=document.createElement('button');b.type='button';b.setAttribute('data-task',t.taskId);var d=describe(t);
 var id=document.createElement('span');id.className='tid';id.textContent=t.taskId;
 var what=document.createElement('span');what.className='what';var c=document.createElement('span');chip(c,d);
 var when=document.createElement('span');when.className='when';when.textContent=hhmm(t.updatedAtMs);
 what.appendChild(c);what.appendChild(document.createTextNode(' '));what.appendChild(when);
 b.appendChild(id);b.appendChild(document.createTextNode(' '));b.appendChild(what);
 b.onclick=function(){$('taskId').value=t.taskId;$('tabId').value=(t.tabs&&t.tabs[0])||'';watch()};return b}
function listTasks(){if(!S.token)return;$('tasks').className='muted';$('tasks').textContent=T.loading;
 op('listTasks',{profileId:S.profileId}).then(function(r){var box=$('tasks');box.textContent='';box.className='';
  if(!r.tasks.length){emptyState(box,T.noTasksTitle,T.noTasks);return}
  // Tasks waiting for the user come first; the others (running, parked for the agent) are folded away.
  var others=document.createElement('details'),summary=document.createElement('summary'),folded=0,first=null;others.appendChild(summary);
  r.tasks.forEach(function(t){var b=taskButton(t);
   if(waitsForUser(t)){box.appendChild(b);if(!first)first=t}else{others.appendChild(b);folded++}});
  if(folded){summary.textContent=T.others(folded);box.appendChild(others)}
  if(S.task)markSelected(S.task.taskId);
  // Opened to deal with something: show the first task that needs the user right away.
  else if(first&&!$('taskId').value){$('taskId').value=first.taskId;$('tabId').value=(first.tabs&&first.tabs[0])||'';watch()}
 },function(e){$('tasks').textContent=e.message;$('tasks').className='warn-text small'})}
/** Same rule as the Runtime's sessionWaiting: the user's move now (a stale approval on a task being cancelled is not). */
function waitsForUser(t){if(t.cancelRequested)return false;return !!t.pendingApproval||t.status==='awaiting-user'||t.pauseReason==='user-control'
 ||(t.pauseReason==='grant-expired'&&(t.waitReason==='login'||t.waitReason==='captcha'||t.waitReason==='handoff'))}
/** The Runtime checks the selected tab's own lease epoch, not a global maximum. */
function tabEpoch(){var tab=$('tabId').value.trim();var leases=(S.task&&S.task.tabLeases)||[];for(var i=0;i<leases.length;i++)if(leases[i].tabId===tab)return leases[i].leaseEpoch;return 0}
function addEvent(e){if(S.seen[e.seq])return;S.seen[e.seq]=1;if(e.seq>S.cursor)S.cursor=e.seq;
 var line=document.createElement('div');var t=document.createElement('span');t.className='t';t.textContent='#'+e.seq;
 var k=document.createElement('span');k.className='k';k.textContent=e.type;var d=document.createElement('span');d.className='d';
 var data=JSON.stringify(e.data);d.textContent=data;d.title=data;line.appendChild(t);line.appendChild(k);line.appendChild(d);$('events').prepend(line)}
/** A late answer for a task the user has since left (an automatic pick racing a manual one) is dropped. */
function refresh(){return op('getTask',{taskId:$('taskId').value.trim()}).then(function(t){if(t&&t.taskId===$('taskId').value.trim())showTask(t)})}
function loop(gen){if(gen!==S.gen)return;
 op('subscribe',{taskId:$('taskId').value.trim(),afterSeq:S.cursor,waitMs:25000}).then(function(r){
  if(gen!==S.gen)return;$('conn').textContent=T.live;
  if(r.kind==='snapshot-required'){S.cursor=r.highWatermarkSeq;S.seen={};showTask(r.snapshot)}
  else if(r.events.length){r.events.forEach(addEvent);return refresh()}
 }).then(function(){loop(gen)},function(e){$('conn').textContent=e.message+' ('+T.retrying+')';setTimeout(function(){loop(gen)},2000)})}
function watch(){S.cursor=0;S.seen={};$('events').textContent='';var gen=++S.gen;refresh().then(function(){loop(gen)},function(e){$('conn').textContent=e.message})}
$('useToken').onclick=function(){if(setCapability($('token').value.trim()))listTasks();$('token').value=''};
$('refreshTasks').onclick=listTasks;$('connect').onclick=watch;
function act(p){var out=$('actionResult');out.className='';out.textContent='…';
 p.then(function(r){var v=r.status||r.outcome||r.owner;out.textContent=typeof v==='string'?T.ok+' · '+v:T.ok;if(r.task)showTask(r.task);return refresh()})
 .catch(function(e){out.className='err';out.textContent=e.message;if(e.body&&e.body.code==='STALE_LEASE')refresh()})}
function decide(d){var a=S.task&&S.task.pendingApproval;if(!a)return;act(op('approve',{taskId:S.task.taskId,approvalId:a.approvalId,bindingHash:a.bindingHash,requestId:rid(),decision:d}))}
$('approve').onclick=function(){decide('approve')};$('reject').onclick=function(){decide('reject')};
$('takeOver').onclick=function(){act(op('takeOver',{taskId:$('taskId').value.trim(),tabId:$('tabId').value.trim(),expectedEpoch:tabEpoch(),requestId:rid()}))};
$('release').onclick=function(){act(op('releaseControl',{taskId:$('taskId').value.trim(),tabId:$('tabId').value.trim(),expectedEpoch:tabEpoch(),requestId:rid()}))};
$('resume').onclick=function(){if(S.task)act(op('resume',{taskId:S.task.taskId,expectedVersion:S.task.stateVersion,requestId:rid()}))};
$('stop').onclick=function(){act(op('cancel',{taskId:$('taskId').value.trim(),requestId:rid()}))};
/** A viewer connection is bound to the capability it was ticketed with: renewal reconnects it. */
/** The screen counts as open from the click, so a renewal during the first ticket request reopens it; only the latest reply is shown. */
function openScreen(){S.screenOpen=true;var n=++S.screenSeq;op('viewerTicket',{profileId:S.profileId}).then(function(r){if(n!==S.screenSeq)return;
 var path='v1/viewer/websockify?ticket='+encodeURIComponent(r.ticket);window.__abpViewerPath=path;
 $('screen').src='/viewer/vnc_lite.html?path='+encodeURIComponent(path);$('screenBox').hidden=false
},function(e){if(n!==S.screenSeq)return;S.screenOpen=false;var out=$('actionResult');out.className='err';out.textContent=e.message})}
$('openScreen').onclick=openScreen;
// Reload, back navigation or a restored panel arrive without a fragment: ask the host now.
if(S.token)listTasks();else askHost();
})();
</script></body></html>`
}
