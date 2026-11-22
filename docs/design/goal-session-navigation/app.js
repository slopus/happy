const icons={folder:'M3 6h6l2 2h10v12H3z',chat:'M21 11a8 8 0 0 1-8 8H7l-4 3 1-6a8 8 0 1 1 17-5z',file:'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',plus:'M12 5v14 M5 12h14',search:'M17 17l5 5 M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0',chevron:'m8 5 7 7-7 7',down:'m5 9 7 7 7-7',home:'m2 11 10-9 10 9 M5 9v12h5v-7h4v7h5V9',cpu:'M6 6h12v12H6z M9 1v5 M15 1v5 M9 18v5 M15 18v5 M1 9h5 M1 15h5 M18 9h5 M18 15h5',grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',edit:'M20 14v7H3V4h10 M10 13l-1 4 4-1L22 7l-3-3z',list:'M8 6h13 M8 12h13 M8 18h13 M3 6h1 M3 12h1 M3 18h1',bell:'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 21h4',help:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M9 8c0-4 8-3 6 1l-3 3v3 M12 18h0',clock:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 6v6l4 3',more:'M5 12h1 M11 12h1 M17 12h1',monitor:'M2 3h20v14H2z M12 17v5 M7 22h10',compass:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M16 7l-3 7-6 3 3-7z',panel:'M3 3h18v18H3z M15 3v18',arrow:'M12 20V4 M5 11l7-7 7 7',check:'m5 12 4 4L20 5'};
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name]||icons.file}"/></svg>`;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=s=>document.querySelector(s);const groups=[{id:'global',name:'全局对话',path:'Happy / 全局',dir:'happy/',description:'讨论项目方向、跨子项目协作，以及尚未归属的想法。'},{id:'web',name:'Page Review',path:'Happy / Page Review',dir:'features/page-review/',description:'网页标注、登录授权与资料交接。'},{id:'cli',name:'CLI 与模型',path:'Happy / CLI 与模型',dir:'features/cli-and-models/',description:'命令行发布、模型配置和跨端运行。'},{id:'mobile',name:'移动端体验',path:'Happy / 移动端体验',dir:'features/mobile-experience/',description:'移动端交互与会话体验。'}];
const seed=[
{id:'g1',g:'global',title:'讨论项目目标与下一步',state:'done',time:'今天 10:42'},
{id:'g2',g:'global',title:'梳理项目与子项目的关系',state:'unseen',time:'今天 09:35'},
{id:'g3',g:'global',title:'项目协作流程与归档约定',state:'done',time:'昨天'},
{id:'w1',g:'web',title:'确认登录恢复后的验收范围',state:'waiting',time:'4 分钟前'},
{id:'w2',g:'web',title:'修复网页引用与源码入口',state:'running',time:'正在执行'},
{id:'w3',g:'web',title:'网页标注与 AI 读取',state:'done',time:'12 分钟前'},
{id:'w4',g:'web',title:'浏览器存储容量与迁移方案',state:'running',time:'正在执行'},
{id:'w5',g:'web',title:'插件回调与登录链路检查',state:'unseen',time:'昨天'},
{id:'c1',g:'cli',title:'验证默认模型设置是否生效',state:'running',time:'正在执行'},
{id:'c2',g:'cli',title:'CLI 发布与本机升级',state:'done',time:'今天 08:20'},
{id:'c3',g:'cli',title:'模型切换与历史接续',state:'done',time:'11 月 20 日'}];
let sessions=structuredClone(seed),selected='w3',tab='sessions',filter='all',query='',baseline=new URLSearchParams(location.search).has('baseline'),collapsed=new Set(),drafts={},messages={},file='';
const statuses={waiting:'待回复',unseen:'待查看',running:'执行中',done:'已完成',idle:'未开始'};
const status=s=>`<span class="status ${s}">${statuses[s]}</span>`;
function counts(){return {all:sessions.length,attention:sessions.filter(s=>['waiting','unseen'].includes(s.state)).length,running:sessions.filter(s=>s.state==='running').length}}
function hydrateIcons(){document.querySelectorAll('[data-icon]').forEach(el=>el.outerHTML=icon(el.dataset.icon))}
function render(){document.body.classList.toggle('baseline',baseline);$('#baseline').textContent=baseline?'返回设计稿':'查看原布局';$('#tabcount').textContent=sessions.length;document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-selected',b.dataset.tab===tab)});renderRight();renderChat();hydrateIcons()}
function renderRight(){
if(tab==='sessions'){
 const n=counts();$('#rightcontent').innerHTML=`<div class="project"><div class="projectname">${icon('folder')}<strong>Happy</strong><span class="count">${n.all} 个会话 · 3 个子项目</span></div><div class="path">projects/happy/</div><div class="summary"><button data-filter="all" class="${filter==='all'?'on':''}">全部 <b>${n.all}</b></button><button data-filter="attention" class="attention ${filter==='attention'?'on':''}">待处理 <b>${n.attention}</b></button><button data-filter="running" class="running ${filter==='running'?'on':''}">执行中 <b>${n.running}</b></button></div></div><label class="searchbox">${icon('search')}<input id="search" aria-label="搜索会话或子项目" placeholder="搜索会话或子项目" value="${esc(query)}"></label><div class="groups" id="groups"></div>`;renderGroups();
}else if(tab==='details'){
 const s=sessions.find(s=>s.id===selected),g=groups.find(g=>g.id===s.g);$('#rightcontent').innerHTML=`<div class="detail"><h3>${esc(g.name)}</h3><p>${g.description}</p><label>项目路径</label><div class="path">projects/happy/${g.id==='global'?'':g.dir}</div><label>当前会话</label><p>${esc(s.title)}</p>${status(s.state)}<label>关联范围</label><p>此分组共 ${sessions.filter(s=>s.g===g.id).length} 个会话。创建新对话时，自动关联这个范围。</p><button data-tab="sessions">${icon('chat')}查看同组会话</button></div>`;
}else{
 $('#rightcontent').innerHTML=file?`<div class="detail"><button class="backfile" id="backfile">‹ 返回文件</button><h3>${esc(file)}</h3><div class="fileview"># Happy 项目\n\n这是交互预览中的演示文件。\n项目、子项目与会话保持独立关联。\n\n状态：规划中</div></div>`:`<div class="detail"><div class="summary"><span>文件</span><span class="muted">　已删除</span></div><label>Happy</label><div class="searchbox" style="margin:10px 0">${icon('search')}<span style="font-size:12px">筛选已加载的文件…</span></div>${['features/','artifacts/','evidence/','tasks/','index.md','history.md','problem.md'].map(f=>`<button class="file filebutton" data-file="${f}">${icon(f.endsWith('/')?'folder':'file')}${f}</button>`).join('')}</div>`;
}
}
function renderGroups(){let visible=0;$('#groups').innerHTML=groups.map(g=>{
 const all=sessions.filter(s=>s.g===g.id),list=all.filter(s=>(filter==='all'||filter==='attention'&&['waiting','unseen'].includes(s.state)||filter==='running'&&s.state==='running')&&(!query||(s.title+' '+g.name+' '+g.dir).toLowerCase().includes(query.toLowerCase())));
 if((filter!=='all'||query)&&!list.length)return '';visible+=list.length;
 return `<section class="group"><div class="grouphead"><button class="grouptoggle" data-collapse="${g.id}" aria-expanded="${!collapsed.has(g.id)}">${icon(collapsed.has(g.id)?'chevron':'down')}${icon(g.id==='global'?'compass':'folder')}<strong>${g.name}</strong><small>${all.length}</small></button><button class="plus" data-new="${g.id}" aria-label="在${g.name}中新建会话" title="在${g.name}中新建会话">${icon('plus')}</button></div><div class="grouppath">${g.dir}</div>${collapsed.has(g.id)?'':list.length?list.map(s=>`<button class="session ${s.id===selected?'selected':''}" data-session="${s.id}" ${s.id===selected?'aria-current="true"':''}><div class="line"><span class="title">${esc(s.title)}</span>${s.id===selected?'<span class="current">当前</span>':s.state==='unseen'?'<span class="unread" aria-label="未查看"></span>':''}</div><div class="rowmeta">${status(s.state)}<span>${s.time}</span></div></button>`).join(''):`<div class="empty">还没有会话<br><button data-new="${g.id}">＋ 开启第一个会话</button></div>`}</section>`;
}).join('');if(!visible&&(filter!=='all'||query))$('#groups').innerHTML='<div class="empty">没有匹配的会话<br>试试其他关键词或切回“全部”</div>'}
function renderChat(){
const s=sessions.find(s=>s.id===selected),g=groups.find(g=>g.id===s.g);$('#context').textContent=g.path;$('#breadcrumb').textContent=g.id==='global'?'全局目标':g.name;$('#chatTitle').textContent=s.title;$('#mainstatus').innerHTML=status(s.state);$('#chatScope').textContent=g.id==='global'?'全局对话':'子项目对话';$('#chatcount').textContent='· '+sessions.filter(x=>x.g===g.id).length;$('#scopehint').innerHTML=icon('folder')+esc(g.path);$('#draft').value=drafts[s.id]||'';
let body='';if(s.state==='idle'&&!messages[s.id]){body=`<div class="blank">${icon('chat')}<h3>从这里开始新对话</h3><p>自动归属 ${g.path}</p><p>输入第一条消息，开始这次讨论。</p></div>`}
else if(s.id==='w3'){body=`<div class="bubble">帮我梳理网页标注与 AI 读取的完整流程，整理检查结果和接下来需要确认的事项。</div><div class="work">${icon('check')} 已完成 · 6 分钟</div><div class="answer"><p>网页标注与 AI 读取的主流程已梳理完成。标注保存后可以交接到会话，相关资料继续保留在当前子项目中。</p><h3>本次已完成</h3><p>核对了标注入口、资料关联和历史读取路径，并整理了各阶段的检查结果。</p><div class="result"><strong>${icon('file')} 流程核对记录</strong>包含流程说明、结果和后续事项<br><span class="path">features/page-review/artifacts/review.md</span></div><p>下一步可以继续讨论本子项目，也可以在右侧切换到其他会话查看结果。</p><p class="muted" style="font-size:12px">以上为设计预览中的演示内容。</p></div>`}
else if(s.state==='waiting'){body=`<div class="bubble">检查登录恢复后的状态，并列出还需要补充的验证。</div><div class="work">${icon('chat')} 等待你的回复</div><div class="answer"><p>演示检查已完成，当前有一项需要你确认：</p><div class="result"><strong>需要确认验收范围</strong>这次先验证登录与回调，还是同时覆盖重启后的恢复？</div><p>你可以在下方回复。切换查看其他会话时，这条待回复提醒仍会保留。</p></div>`}
else if(s.state==='running'){body=`<div class="bubble">${esc(s.title)}，完成后整理结果与待处理事项。</div><div class="work">${icon('cpu')} 执行中 · 演示状态</div><div class="answer"><p>任务正在执行。你可以先切到同项目的其他会话，右侧会保留这条会话的执行状态。</p><div class="result"><strong>当前范围：${g.name}</strong><span class="path">${g.dir}</span></div></div>`}
else{body=`<div class="bubble">${esc(s.title)}，请整理目标、现状和下一步。</div><div class="work">${icon('check')} 已完成</div><div class="answer"><p>已经整理了“${esc(s.title)}”的讨论结果，相关记录保留在 ${g.name} 中。</p><div class="result"><strong>本次讨论结果</strong>目标与当前范围已明确，后续可以在本会话继续，也可以在同组开启新对话。</div><p>这是用于展示会话切换的演示内容。</p></div>`}
if(messages[s.id])body+=messages[s.id].map(m=>`<div class="bubble">${esc(m)}</div><div class="answer demoresult">已记录这条演示消息。正式接入后，将在 ${esc(g.path)} 的当前会话中继续执行。</div>`).join('');$('#chatbody').innerHTML=body;$('#foottext').textContent=filter==='attention'?'待回复需发送回复；待查看在打开后消除':'当前会话已定位到所属分组';
}
function choose(id){drafts[selected]=$('#draft').value;selected=id;const s=sessions.find(s=>s.id===id);if(s.state==='unseen')s.state='done';render();$('#chatbody').scrollTop=0}
function newChat(gid){drafts[selected]=$('#draft').value;const g=groups.find(g=>g.id===gid),id='new-'+Date.now();sessions.unshift({id,g:gid,title:'新的'+(g.id==='global'?'全局':g.name)+'对话',state:'idle',time:'刚刚'});selected=id;collapsed.delete(gid);filter='all';query='';tab='sessions';render();$('#draft').focus()}
document.addEventListener('click',e=>{
const btn=e.target.closest('button');if(!btn)return;
if(btn.dataset.tab){tab=btn.dataset.tab;render()}
else if(btn.dataset.filter){filter=btn.dataset.filter;renderRight()}
else if(btn.dataset.collapse){const id=btn.dataset.collapse;collapsed.has(id)?collapsed.delete(id):collapsed.add(id);renderGroups()}
else if(btn.dataset.session)choose(btn.dataset.session);
else if(btn.dataset.new)newChat(btn.dataset.new);
else if(btn.dataset.file){file=btn.dataset.file;renderRight()}
else if(btn.id==='backfile'){file='';renderRight()}
else if(btn.id==='newMain')newChat(sessions.find(s=>s.id===selected).g);
else if(btn.id==='baseline'){drafts[selected]=$('#draft').value;baseline=!baseline;tab=baseline?'files':'sessions';render()}
else if(btn.id==='reset'){sessions=structuredClone(seed);selected='w3';filter='all';query='';drafts={};messages={};collapsed.clear();tab=baseline?'files':'sessions';render()}
else if(btn.id==='send'){const text=$('#draft').value.trim();if(!text)return;const s=sessions.find(s=>s.id===selected);(messages[s.id]??=[]).push(text);drafts[s.id]='';s.state='running';s.time='刚刚';if(s.id.startsWith('new-'))s.title=text.length>20?text.slice(0,20)+'…':text;render();$('#chatbody').scrollTop=$('#chatbody').scrollHeight}
});document.addEventListener('input',e=>{if(e.target.id==='search'){query=e.target.value;renderGroups()}if(e.target.id==='draft')drafts[selected]=e.target.value});
if(baseline)tab='files';render();
