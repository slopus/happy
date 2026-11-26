(() => {
 'use strict';
 const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
 let toastAnimation=null,toastToken=0;
 pawsPrototype.toast=text=>{const e=$('#toast');const token=++toastToken;toastAnimation?.cancel();e.textContent=text;e.hidden=false;toastAnimation=e.animate([{opacity:1,offset:0},{opacity:1,offset:.82},{opacity:0,offset:1}],{duration:3200});toastAnimation.finished.then(()=>{if(token===toastToken)e.hidden=true;}).catch(()=>{});};
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const glyph={film:'f2ff',file:'f2b4',web:'f3f1',close:'f24e',add:'f107',folder:'f327',back:'f22d',play:'f4d6',pause:'f497',note:'f20d',next:'f23b',check:'f21f',expand:'f2e1',contract:'f28a'};
 const icon=n=>pawsPrototype.icon(glyph[n]||glyph.file);
 const items=[
  {id:'film-1',title:'Paws 宣传片',kind:'film',label:'影片工程',meta:'8.5 秒 · v12 · 今天 14:32',version:'v12'},
  {id:'export-1',title:'Paws 宣传片.mp4',kind:'export',label:'导出视频',meta:'1440 × 1152 · 8.5 秒 · v11 导出',version:'v11'},
  {id:'web-1',title:'品牌首页',kind:'web',label:'网页',meta:'落地页 · 今天 11:18',version:'v3'},
  {id:'doc-1',title:'影片策划.md',kind:'doc',label:'文档',meta:'创意与脚本 · 今天 10:42',version:'v2'},
  {id:'doc-2',title:'登录排查记录.md',kind:'doc',label:'文档',meta:'问题记录 · 今天 09:36',version:'v1'}
 ];
 const seed=[
  {id:'creative',title:'宣传片创作',sub:'影片与镜头节奏',refs:['film-1','export-1','doc-1'],target:null,draft:'',messages:[]},
  {id:'music',title:'配乐调整',sub:'同一工程 · 声音与落点',refs:['film-1'],target:null,draft:'',messages:[]},
  {id:'debug',title:'登录问题排查',sub:'接口与登录状态',refs:['doc-2'],target:null,draft:'',messages:[]}
 ];
 const key='paws-contextual-artifacts-v2';
 let cached;try{cached=JSON.parse(localStorage.getItem(key)||'null');}catch{}
 let sessions=cached?.sessions?.length?cached.sessions:seed;
 let current=sessions.some(s=>s.id===cached?.current)?cached.current:'creative';
 let editorSaved=cached?.editorSaved||{},queue=cached?.queue||[];
 let projectMode=false,opened=null,loadAnimation=null,generation=0,notesOpen=false,noteDraft='',noteSaved='',noteTime=1.6,time=1.6,playing=false,playToken=0;
 const session=()=>sessions.find(s=>s.id===current), item=id=>items.find(a=>a.id===id);
 const store=()=>{try{localStorage.setItem(key,JSON.stringify({sessions,current,editorSaved,queue}));}catch{pawsPrototype.toast('浏览器未允许本地保存；刷新可能丢失演示修改。');}};
 const composer=$('.source-composer textarea'),send=$('.source-composer button[aria-label="发送演示消息"]');
  const artifactIcon=a=>icon(a.kind==='film'||a.kind==='export'?'film':a.kind==='web'?'web':'file');
 function dialog(id,name,protect=false){
  const d=document.createElement('dialog');d.id=id;d.className='flow-dialog';d.setAttribute('aria-label',name);document.body.append(d);
  d.addEventListener('click',e=>{const r=d.getBoundingClientRect();if(!protect&&e.target===d&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))d.close();});
  d.addEventListener('close',()=>{if(d._trigger?.isConnected)d._trigger.focus();});
  d.addEventListener('keydown',e=>{if(e.isComposing){if(e.key==='Escape')e.preventDefault();return;}if(e.key!=='Tab')return;const controls=[...d.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')].filter(n=>!n.disabled&&n.tabIndex>=0&&n.getClientRects().length);if(!controls.length){e.preventDefault();return;}const first=controls[0],last=controls[controls.length-1];if(e.shiftKey&&(document.activeElement===first||!d.contains(document.activeElement))){e.preventDefault();last.focus();}else if(!e.shiftKey&&(document.activeElement===last||!d.contains(document.activeElement))){e.preventDefault();first.focus();}});return d;
 }
 const picker=dialog('artifact-picker','关联项目产物'),chooser=dialog('session-chooser','选择会话继续修改'),viewer=dialog('artifact-viewer','查看产物'),guard=dialog('draft-guard','标注尚未保存',true),unlink=dialog('unlink-dialog','移除会话关联',true);
 const heading=t=>`<header class="dialog-head"><h2>${t}</h2><button class="icon-button" data-close aria-label="关闭${t}">${icon('close')}</button></header>`;
 function show(d,html,focus){$('#toast').hidden=true;d._trigger=document.activeElement;d.innerHTML=html;if(!d.open)d.showModal();d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());(d.querySelector(focus)||d.querySelector('button'))?.focus();}
 function saveNote(){if(!opened)return;noteSaved=noteDraft;editorSaved[opened]={...editorSaved[opened],note:noteSaved,noteTime,time};store();syncNote();}
 function dirty(){return opened&&notesOpen&&noteDraft!==noteSaved;}
 function protect(next){
  if(!dirty()){next();return;}
  show(guard,heading('标注尚未保存')+`<div class="dialog-body"><p>保存这条标注后再离开？</p><footer class="dialog-footer"><button class="flow-button" data-close>留在这里</button><button class="flow-button destructive" id="discard-draft">放弃本次编辑</button><button class="flow-button primary" id="save-continue">保存并继续</button></footer></div>`,'[data-close]');
  $('#discard-draft').onclick=()=>{noteDraft=noteSaved;guard.close();next();};$('#save-continue').onclick=()=>{saveNote();guard.close();next();};
 }
 function closeEditor(){protect(()=>{dispose();render();$('#project-products')?.focus();});}
 function stop(){playing=false;playToken++;if($('#play-demo')){$('#play-demo').innerHTML=icon('play');$('#play-demo').setAttribute('aria-label','播放画面示意');}}
 function dispose(){generation++;loadAnimation?.cancel();stop();opened=null;notesOpen=false;$('#editor-panel')?.remove();$('#project-ai-placeholder')?.remove();$('#workspace-shell').classList.remove('editing','is-max');}
 function switchSession(id){
  if(id===current&&!projectMode)return;
  const next=()=>{session().draft=composer.value;current=id;projectMode=false;if(opened&&!session().refs.includes(opened))dispose();store();render();};
  if(opened&&!sessions.find(s=>s.id===id)?.refs.includes(opened))protect(next);else next();
 }
 $('.review-brand').innerHTML='Paws / 产物与会话<span>交互稿 V2 · 全部为本地演示</span>';
 $('.review-note').textContent='先找产物，再按需进入工作台';
 $('#design-link').textContent='交互稿';
 $('.review-actions').insertAdjacentHTML('afterbegin','<select id="review-scene" aria-label="演练入口"><option value="creative">相关会话</option><option value="debug">普通会话</option><option value="project">项目产物</option></select>');
 $('#review-scene').onchange=e=>{const v=e.target.value;e.target.value=projectMode?'project':current==='debug'?'debug':'creative';if(v==='project')openProject();else switchSession(v);};
 $('.session-sidebar').innerHTML=`<div class="side-head">Paws<div class="side-tools"><button aria-label="搜索会话">${pawsPrototype.icon('f1d0','feather')}</button></div></div><button class="new-session" id="new-chat">${icon('add')}新建会话</button><div class="section-label">项目</div><button class="project-overview" id="project-products">${icon('folder')}<span>品牌项目<small>查看项目产物</small></span>${icon('next')}</button><div class="session-section"><span>项目会话</span><span id="session-count"></span></div><div id="session-list"></div><div class="side-footnote">项目保存产物<br>会话按需关联，同目录不自动关联</div>`;
 $('#project-products').onclick=openProject;
 $('.rail button[aria-label="全部项目"]').onclick=openProject;
 $('#new-chat').onclick=()=>{protect(()=>{dispose();createSession(null);});};
 $('.composer-wrap').insertAdjacentHTML('afterbegin','<div class="reference-bar" id="reference-bar"></div>');
 $('.composer-wrap').insertAdjacentHTML('beforeend','<div class="composer-context"><button id="associate-product">＋ 关联产物</button><button id="mobile-products">查看项目产物</button><span id="context-copy">只发送本条输入</span></div>');
 $('#associate-product').onclick=()=>openPicker();$('#mobile-products').onclick=openProject;
 composer.placeholder='输入消息，或关联产物继续修改…';
 composer.addEventListener('input',()=>{session().draft=composer.value;store();syncSend();});
 composer.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.isComposing){e.preventDefault();send.click();}});
 send.onclick=()=>{const text=composer.value.trim();if(!text)return;const target=session().target;const a=item(target);session().messages.push({text,target:a?.id||null,version:a?.version||null});composer.value='';session().draft='';store();renderMessages();renderTarget();syncSend();pawsPrototype.toast('已加入本地演示对话，未调用真实 AI。');};
 function syncSend(){send.disabled=projectMode||!composer.value.trim();}
 function sessionRows(){
  $('#session-count').textContent=sessions.length;
  $('#session-list').innerHTML=sessions.map(s=>`<div class="sample-session ${!projectMode&&s.id===current?'active':''}"><button data-session="${s.id}"><span class="session-copy"><strong>${esc(s.title)}</strong><small>${esc(s.sub||'品牌项目')}</small></span><span class="session-ref-count">${s.refs.length||''}</span></button></div>`).join('');
  $$('[data-session]').forEach(b=>b.onclick=()=>switchSession(b.dataset.session));
  $('#project-products').classList.toggle('selected',projectMode);
 }
 function card(a){return `<div class="artifact-message-card" data-card="${a.id}"><div class="artifact-cover ${a.kind}">${a.kind==='film'?'<b>Paws</b><i>Keep your ideas moving.</i><div class="mini-page"></div>':artifactIcon(a)}<span>${a.label}</span></div><div class="artifact-card-body"><div><strong>${esc(a.title)}</strong><small>${a.meta}</small></div><p>${a.kind==='film'?'可继续调整画布、时间线与 AI 标注。':a.kind==='export'?'导出成品；继续剪辑请打开关联的影片工程。':'已保存在品牌项目中。'}</p><div class="artifact-card-actions"><button class="flow-button secondary" data-open="${a.id}">${a.kind==='film'?'打开工程':'查看'+a.label}</button>${a.kind==='film'&&!projectMode?`<button class="flow-button" data-target="${a.id}">设为本次修改对象</button>`:''}</div></div></div>`;}
 function renderMessages(){
  const s=session();let body='';
  if(s.id==='creative')body=`<div class="message user">把开头飞得更明显，后半段加快，直接落到结尾。</div><article class="message"><div class="meta">${icon('check')}Codex · 已完成</div><h2>影片工程已保留，可以继续修改</h2><p>从工程卡片打开工作台，查看画面或添加标注。需要 AI 修改时，再指定本次修改对象。</p>${s.refs.includes('film-1')?card(item('film-1')):'<p class="small-hint">此会话已移除影片关联。项目产物仍然保留。</p>'}<div class="inline-artifacts">${s.refs.includes('export-1')?'<button data-open="export-1">'+icon('film')+'Paws 宣传片.mp4 <small>导出视频</small></button>':''}${s.refs.includes('doc-1')?'<button data-open="doc-1">'+icon('file')+'影片策划.md</button>':''}</div></article>`;
  else if(s.id==='music')body=`<div class="message user">这条片子的摩擦声有点刺耳，想换柔和一点的配乐。</div><article class="message"><div class="meta">${icon('check')}Codex · 已完成</div><h2>继续使用同一份影片工程</h2><p>这里关联的是「宣传片创作」中的原工程。修改结果会在两边看到；对话和输入草稿分别保留。</p>${s.refs.includes('film-1')?card(item('film-1')):''}</article>`;
  else if(s.id==='debug')body=`<div class="message user">登录后偶尔回到登录页，帮我查一下原因。</div><article class="message"><div class="meta">${icon('check')}Codex · 已完成</div><h2>先核对登录状态与重定向</h2><p>已整理复现步骤与接口记录，可以在文档中继续补充。</p>${s.refs.includes('doc-2')?card(item('doc-2')):''}<p class="small-hint">这个会话只关联排查文档。共享工作目录中的影片不会自动加入。</p></article>`;
  else body=`<article class="message"><h2>${esc(s.title)}</h2><p>输入要求后继续协作。新建会话不会自动向 AI 发送内容。</p>${s.refs.includes('film-1')?card(item('film-1')):''}</article>`;
  body+=s.messages.map(m=>`<div class="message user queued-message">${m.target?`<div class="frozen-reference">${artifactIcon(item(m.target))} ${esc(item(m.target).title)} · ${m.version}${m.time!==undefined?' · '+m.time.toFixed(1)+'s':''}<small>发送时锁定</small></div>`:''}<div>${esc(m.text).replaceAll('\n','<br>')}</div><small class="local-label">${m.annotation?'标注请求已加入本地队列 · 未调用真实 AI':'本地演示消息'}</small></div>`).join('');
  $('#conversation').innerHTML=body;wireArtifactActions($('#conversation'));if(s.messages.length)$('#conversation').scrollTop=$('#conversation').scrollHeight;
 }
 function renderTarget(){
  const a=item(session().target);$('#reference-bar').innerHTML=a?`<div class="target-pill">${artifactIcon(a)}<span>本次修改：<b>${esc(a.title)}</b><small>${a.version}</small></span><button id="clear-target" aria-label="清除本次修改对象">${icon('close')}</button></div>`:'';
  $('#clear-target')?.addEventListener('click',()=>{session().target=null;store();renderTarget();pawsPrototype.toast('已清除本次修改对象；会话关联仍保留。');});
  $('#context-copy').textContent=a?'发送前请核对修改对象':'只发送本条输入';syncSend();updateEditorContext();
 }
 function setTarget(id){
  if(!session().refs.includes(id))session().refs.push(id);session().target=id;store();renderTarget();renderCapabilities();renderMessages();composer.focus();pawsPrototype.toast('已设为本次修改对象；尚未发送要求。');
 }
 function renderCapabilities(){
  const s=session();$('#capabilities').innerHTML=`<div class="cap-tabs"><button class="selected">${pawsPrototype.icon('f58d')}能力中心</button><button id="cap-project">${icon('folder')}项目</button></div><div class="cap-content"><div class="artifacts-section-head"><h2>本会话产物</h2><span>${s.refs.length}</span></div><p class="section-description">按需关联，不自动收录同目录文件</p><div class="related-list">${s.refs.map(id=>{const a=item(id);return `<div class="related-item"><button class="related-main" data-open="${id}"><span class="artifact-symbol">${artifactIcon(a)}</span><span><strong>${a.title}</strong><small>${a.label} · ${a.version}</small></span></button><button class="unlink-button" data-unlink="${id}" aria-label="移除 ${a.title} 的会话关联">${icon('close')}</button></div>`;}).join('')||'<div class="empty-related">此会话还没有关联产物</div>'}</div><button class="related-add" id="cap-associate">${icon('add')}关联已有产物</button><button class="project-link" id="cap-all">查看品牌项目的全部产物 ${icon('next')}</button><div class="cap-divider"></div><h3 class="secondary-heading">会话工具</h3><div class="compact-tools"><button data-tool="Skills">${pawsPrototype.icon('f31a')}Skills <span>4</span></button><button data-tool="文件">${icon('folder')}文件 <span>3</span></button><button data-tool="会话操作">${pawsPrototype.icon('f2d0')}会话操作</button></div></div>`;
  $('#cap-project').onclick=openProject;$('#cap-all').onclick=openProject;$('#cap-associate').onclick=()=>openPicker();wireArtifactActions($('#capabilities'));$$('[data-tool]').forEach(b=>b.onclick=()=>pawsPrototype.toast('原有会话工具；本稿聚焦产物与会话的关联。'));
  $$('[data-unlink]').forEach(b=>b.onclick=()=>askUnlink(b.dataset.unlink));
 }
 function askUnlink(id){const a=item(id);show(unlink,heading('移除会话关联')+`<div class="dialog-body"><p>从「${esc(session().title)}」移除「${esc(a.title)}」？</p><div class="dialog-notice">不会删除项目原产物，也不影响其他会话。若它是本次修改对象，也会一并清除。</div><footer class="dialog-footer"><button class="flow-button" data-close>取消</button><button class="flow-button destructive" id="confirm-unlink">移除关联</button></footer></div>`);$('#confirm-unlink').onclick=()=>{protect(()=>{session().refs=session().refs.filter(x=>x!==id);if(session().target===id)session().target=null;if(opened===id)dispose();unlink.close();store();render();});};}
 function wireArtifactActions(root){root.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openArtifact(b.dataset.open));root.querySelectorAll('[data-target]').forEach(b=>b.onclick=()=>setTarget(b.dataset.target));}
 function render(){
  $('#toast').hidden=true;sessionRows();$('#review-scene').value=projectMode?'project':current==='debug'?'debug':'creative';
  $('.chat-panel').hidden=projectMode;$('#project-gallery')?.remove();
  if(projectMode){renderGallery();return;}
  const t=$('[data-baseline-title]>div');if(t)t.textContent=session().title;const titleButton=$('[data-baseline-title]');titleButton?.setAttribute('aria-label',session().title);const status=$('#source-header [aria-label="执行中"]');if(status){status.setAttribute('aria-label','已完成');status.textContent='已完成';}
  composer.value=session().draft||'';composer.disabled=false;$('#associate-product').disabled=false;renderMessages();renderCapabilities();renderTarget();
  $('#project-ai-placeholder')?.remove();if(opened)updateEditorContext();
 }
 function openProject(){protect(()=>{session().draft=composer.value;dispose();projectMode=true;store();render();});}
 function renderGallery(){
  $('#capabilities').hidden=true;$('#workspace-shell').classList.add('project-view');
  const el=document.createElement('main');el.id='project-gallery';el.className='project-gallery';el.innerHTML=`<header class="project-gallery-head"><button id="back-chat" class="flow-button">${icon('back')}返回会话</button><span>项目 / 品牌项目</span></header><div class="gallery-intro"><div class="eyebrow">品牌项目</div><h1>项目产物</h1><p>工程、成品与文档集中保存在这里。打开后，可以再选择会话继续协作。</p><div class="gallery-summary"><span><b>5</b> 个产物</span><span><b>1</b> 份影片工程</span><span><b>${sessions.filter(s=>s.refs.includes('film-1')).length}</b> 个会话引用它</span></div></div><div class="gallery-filter"><div class="filter-tabs"><button class="selected" data-filter="all">全部 <span>5</span></button><button data-filter="film">影片工程</button><button data-filter="export">导出视频</button><button data-filter="doc">文档</button></div><input class="flow-input" id="artifact-search" aria-label="搜索项目产物" placeholder="搜索产物名称"></div><div class="artifact-grid" id="artifact-grid"></div><footer class="gallery-foot">项目保存原产物 · 会话通过关联共同使用 · 打开不会自动向 AI 发送要求</footer>`;
  $('#workspace-shell').prepend(el);$('#back-chat').onclick=()=>{projectMode=false;render();};let filter='all';const list=()=>{const q=$('#artifact-search').value.trim().toLowerCase();const found=items.filter(a=>(filter==='all'||a.kind===filter)&&a.title.toLowerCase().includes(q));$('#artifact-grid').innerHTML=found.map(a=>`<article class="gallery-artifact">${card(a)}<div class="gallery-associations">${a.id==='film-1'?'由 '+sessions.filter(s=>s.refs.includes(a.id)).length+' 个会话引用':'保存在品牌项目'}</div></article>`).join('')||'<div class="empty-related">没有匹配的产物，试试其他名称。</div>';wireArtifactActions($('#artifact-grid'));};
  $$('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;$$('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));list();});$('#artifact-search').oninput=list;list();

 }
 function openPicker(){
  show(picker,heading('关联项目产物')+`<div class="dialog-body"><p>品牌项目 · 同目录文件不会自动关联。</p><input class="flow-input" id="picker-search" aria-label="搜索可关联产物" placeholder="搜索项目中的产物"><div id="picker-list"></div><div class="dialog-notice">关联后出现在本会话。选择「设为本次修改对象」才会随下一条消息交给 AI。</div></div>`,'#picker-search');
  function rows(){const q=$('#picker-search').value.trim().toLowerCase();$('#picker-list').innerHTML=items.filter(a=>a.title.toLowerCase().includes(q)).map(a=>`<div class="picker-row"><span class="artifact-symbol">${artifactIcon(a)}</span><span><strong>${a.title}</strong><small>${a.label} · ${a.version}</small></span><button class="flow-button secondary" data-link="${a.id}" ${session().refs.includes(a.id)?'disabled':''}>${session().refs.includes(a.id)?'已关联':'关联'}</button></div>`).join('')||'<p class="empty-related">没有匹配的产物</p>';$$('[data-link]').forEach(b=>b.onclick=()=>{session().refs.push(b.dataset.link);store();render();picker.close();pawsPrototype.toast('已关联到当前会话；尚未设为修改对象。');});}$('#picker-search').oninput=rows;rows();
 }
 function openArtifact(id){
  if(id==='film-1'){protect(()=>openFilm(id));return;}const a=item(id);
  show(viewer,heading(a.label+'预览')+`<div class="dialog-body"><div class="preview-document"><div class="artifact-symbol">${artifactIcon(a)}</div><h3>${esc(a.title)}</h3><p>${a.meta}</p>${a.kind==='export'?'<div class="export-preview"><b>Paws</b><i>Keep your ideas moving.</i><span>导出视频示意 · 本稿未加载真实 MP4</span></div>':a.kind==='doc'?'<p>这是本地演示文档，用于区分普通任务与影片协作。正式内容仍保存在项目中。</p>':'<div class="web-preview"><b>Your agents. In your hands.</b><p>品牌首页示意</p></div>'}</div>${a.kind==='export'?'<button class="flow-button primary" id="open-export-source">打开原影片工程</button>':''}</div>`);
  $('#open-export-source')?.addEventListener('click',()=>{viewer.close();openArtifact('film-1');});
 }
 function createSession(artifactId){
  const s={id:'new-'+(sessions.length+1),title:artifactId?'宣传片继续修改':'新会话',sub:'品牌项目 · 本地演示',refs:artifactId?[artifactId]:[],target:artifactId,draft:'',messages:[]};sessions.push(s);current=s.id;projectMode=false;store();render();composer.focus();pawsPrototype.toast('已创建本地演示会话，尚未调用 AI。');
 }
 function chooseSession(after){
  const a=item(opened);if(!a)return;
  show(chooser,heading(after?'选择会话发送标注':'选择会话继续修改')+`<div class="dialog-body"><p>将「${esc(a.title)}」关联到选择的会话，并设为本次修改对象。</p><div class="dialog-notice">${after?'选中会话后，将这条标注加入本地演示队列，锁定工程与版本；不会调用真实 AI。':'只准备编辑上下文，选择后仍需你发送要求。'}</div><div class="choose-list">${sessions.map(s=>`<button class="choose-session" data-choose="${s.id}"><span><strong>${esc(s.title)}</strong><small>${s.refs.includes(a.id)?'已引用这份工程':'尚未关联 · 选择后添加'}</small></span>${icon('next')}</button>`).join('')}</div><button class="flow-button secondary" id="create-and-link">${icon('add')}新建会话继续修改</button></div>`);
  $$('[data-choose]').forEach(b=>b.onclick=()=>{session().draft=composer.value;current=b.dataset.choose;projectMode=false;if(!session().refs.includes(a.id))session().refs.push(a.id);session().target=a.id;chooser.close();store();render();after?.();});
  $('#create-and-link').onclick=()=>{chooser.close();createSession(a.id);after?.();};
 }
 function editorHeader(){return `<header class="editor-header">${icon('film')}<strong class="editor-project-title">Paws 宣传片 <small>v12</small></strong><span class="save-state" id="save-state">已保存</span><button class="icon-button" id="expand-editor" aria-label="放大剪辑区">${icon('expand')}</button><button class="icon-button" id="close-editor" aria-label="关闭剪辑区">${icon('close')}</button></header>`;}
 function wireEditor(){
  $('#close-editor').onclick=closeEditor;$('#expand-editor').onclick=()=>{const m=$('#workspace-shell').classList.toggle('is-max');$('#expand-editor').innerHTML=icon(m?'contract':'expand');$('#expand-editor').setAttribute('aria-label',m?'恢复并排查看':'放大剪辑区');};
 }
 function openFilm(id){
  if(opened===id){pawsPrototype.toast('这份工程已经打开。');return;}
  const fromProject=projectMode;dispose();opened=id;time=editorSaved[id]?.time??1.6;noteDraft=noteSaved=editorSaved[id]?.note||'';noteTime=editorSaved[id]?.noteTime??time;
  $('#project-gallery')?.remove();$('#workspace-shell').classList.remove('project-view');$('#workspace-shell').classList.add('editing');$('#capabilities').hidden=true;
  if(fromProject){$('.chat-panel').hidden=true;$('#workspace-shell').insertAdjacentHTML('afterbegin','<section id="project-ai-placeholder" class="project-ai-placeholder"><div class="eyebrow">品牌项目 / 影片工程</div><h2>打开工程，随时继续协作</h2><p>画布和时间线可以独立查看。需要 AI 修改时，再选择会话。</p><button class="flow-button primary" id="placeholder-choose">选择会话继续修改</button><button class="flow-button" id="placeholder-back">返回项目产物</button><div class="ownership-note">原工程保存在项目中<br>会话只保存引用，不复制工程</div></section>');$('#placeholder-choose').onclick=()=>chooseSession();$('#placeholder-back').onclick=()=>protect(()=>{dispose();$('#project-ai-placeholder')?.remove();projectMode=true;render();});}
  const panel=document.createElement('section');panel.id='editor-panel';panel.className='editor-panel';panel.setAttribute('aria-label','剪辑工作台');$('#workspace-shell').insertBefore(panel,$('#capabilities'));
  panel.dataset.state='opening';panel.innerHTML=editorHeader()+`<div class="editor-body"><div class="opening-state"><div class="opening-copy"><div class="opening-symbol">${icon('film')}</div><h3>正在准备剪辑工作台</h3><p>按需自动准备服务，恢复这份工程的画布和时间线。</p><div class="opening-progress"><span id="open-progress"></span></div><span class="local-label">本稿为有限加载动画，不会启动真实服务</span><div class="opening-actions"><button class="flow-button secondary" id="cancel-open">取消打开</button></div></div></div></div>`;wireEditor();$('#cancel-open').onclick=closeEditor;
  const token=++generation;loadAnimation=$('#open-progress').animate([{transform:'scaleX(.05)'},{transform:'scaleX(1)'}],{duration:matchMedia('(prefers-reduced-motion:reduce)').matches?100:700,fill:'forwards'});loadAnimation.finished.then(()=>{if(generation===token&&opened===id)readyEditor();}).catch(()=>{});
 }
 function updateEditorContext(){
  if(!$('#editor-context'))return;const active=!projectMode&&session().target===opened;$('#editor-context').innerHTML=`<span>${active?'本次修改对象 · '+esc(session().title):'查看工程 · 尚未选为 AI 修改对象'}</span><button id="editor-continue" class="flow-button">${active?'更换协作会话':'选择会话继续修改'}</button>`;$('#editor-continue').onclick=()=>chooseSession();
 }
 function readyEditor(){
  $('#editor-panel').dataset.state='ready';$('#editor-panel').innerHTML=editorHeader()+`<div class="editor-context" id="editor-context"></div><div class="editor-body"><div class="editor-toolbar"><button class="flow-button" id="editor-products">${icon('folder')}项目产物</button><span class="spacer"></span><button class="flow-button" id="add-annotation" aria-expanded="false">${icon('note')}AI 标注</button><span class="save-state">8.5s</span></div><div class="preview-region"><div class="preview-label"><span id="scene-label">首屏飞行</span><span>工程画面示意</span></div><div class="preview-stage"><div class="film-frame" id="film-frame"><div class="film-logo">Paws</div><div class="film-tail">Keep your ideas moving.</div><div class="film-page"><b>Your agents. In your hands.</b><span></span><span></span><i></i></div><div class="film-float"></div><div class="annotation-pin" id="annotation-pin" hidden>1</div></div></div></div><div class="transport"><button id="play-demo" aria-label="播放画面示意">${icon('play')}</button><time id="current-time"></time><input type="range" min="0" max="8.5" step="0.1" aria-label="播放位置" id="playhead"><time>8.5s</time></div><div class="timeline" aria-label="影片时间线"><div class="timeline-ruler"><span>0s</span><span>2.8s</span><span>5.7s</span><span>8.5s</span></div><div class="track"><span class="track-name">场景</span><div class="track-strips"><button class="clip" style="flex:3" data-seek="0">首屏飞行</button><button class="clip" style="flex:3" data-seek="2.5">页面浏览</button><button class="clip" style="flex:4" data-seek="6.5">结尾卡片</button></div></div><div class="track"><span class="track-name">浮起元素</span><div class="track-strips"><span class="clip" style="width:45%">卡片与照片</span><span class="clip" style="width:30%">品牌图标</span></div></div><div class="track"><span class="track-name">声音</span><div class="track-strips"><div class="clip audio"><span>底乐 · 落点</span></div></div></div></div><section class="editor-notes" id="editor-notes" aria-label="AI 标注" hidden></section></div>`;
  wireEditor();updateEditorContext();$('#editor-products').onclick=openProject;$('#add-annotation').onclick=()=>{if(notesOpen){protect(()=>{notesOpen=false;$('#editor-notes').hidden=true;$('#add-annotation').setAttribute('aria-expanded','false');});}else openNotes();};
  $('#playhead').oninput=e=>{stop();seek(Number(e.target.value),true);};$$('[data-seek]').forEach(b=>b.onclick=()=>{stop();seek(Number(b.dataset.seek),true);});$('#play-demo').onclick=togglePlay;seek(time);$('#annotation-pin').hidden=!noteSaved;$('#close-editor').focus();
 }
 function seek(v,persist=false){time=Math.max(0,Math.min(v,8.5));if(!$('#playhead'))return;$('#playhead').value=time;$('#current-time').textContent=time.toFixed(1)+'s';const end=time>=6.2;$('#scene-label').textContent=end?'结尾卡片':time>2.2?'页面浏览':'首屏飞行';$('#film-frame').classList.toggle('end-card',end);$('#film-frame .film-page').style.transform=end?'none':`perspective(600px) rotateX(${36-time*4}deg) translateY(${12-time*4}px)`;if(persist){editorSaved[opened]={...editorSaved[opened],time};store();}}
 function togglePlay(){if(playing){stop();seek(time,true);return;}playing=true;const token=++playToken,start=performance.now(),from=time>=8.5?0:time;$('#play-demo').innerHTML=icon('pause');$('#play-demo').setAttribute('aria-label','暂停画面示意');function frame(now){if(token!==playToken||!playing||!opened)return;seek(from+(now-start)/1000);if(time>=8.5){stop();seek(time,true);}else requestAnimationFrame(frame);}requestAnimationFrame(frame);}
 function syncNote(){if($('#save-state'))$('#save-state').textContent=dirty()?'标注未保存':'已保存';if($('#note-status'))$('#note-status').textContent=dirty()?'未保存':'已保存 · '+noteTime.toFixed(1)+'s';if($('#annotation-pin'))$('#annotation-pin').hidden=!noteSaved.trim();}
 function openNotes(){if(!noteDraft&&!noteSaved)noteTime=time;notesOpen=true;$('#add-annotation').setAttribute('aria-expanded','true');$('#editor-notes').hidden=false;$('#editor-notes').innerHTML=`<div class="notes-head">${icon('note')}AI 标注<span id="note-status"></span></div><textarea id="annotation-text" aria-label="标注修改要求" placeholder="例如：开头再飞高一点，直接落到结尾。">${esc(noteDraft)}</textarea><div class="notes-actions"><button class="flow-button secondary" id="save-note">保存标注</button><button class="flow-button primary" id="send-note">发送标注修改</button></div>`;const sync=()=>{$('#save-note').disabled=$('#send-note').disabled=!noteDraft.trim();syncNote();};$('#annotation-text').oninput=e=>{noteDraft=e.target.value;sync();};$('#save-note').onclick=()=>{saveNote();pawsPrototype.toast('标注已保存到此浏览器的演示工程。');};$('#send-note').onclick=()=>{saveNote();const frozen={target:opened,version:item(opened).version,text:noteDraft,time:noteTime,annotation:true};const submit=()=>{session().messages.push({...frozen});queue.push({...frozen,sessionId:current});store();renderMessages();pawsPrototype.toast('标注请求已加入本地演示队列，目标与版本已锁定；未调用真实 AI。');};if(projectMode||session().target!==opened)chooseSession(submit);else submit();};sync();$('#annotation-text').focus();}
 // Keep the project view and chat view mutually exclusive without changing the sampled header.
 const originalRender=render;
 render=function(){
  $('#workspace-shell').classList.toggle('project-view',projectMode&&!opened);$('#capabilities').hidden=projectMode||!!opened;
  if(!projectMode&&!opened)$('#project-ai-placeholder')?.remove();
  originalRender();
 };
 store();render();document.body.dataset.artifactsReady='true';
})();
