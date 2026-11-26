(() => {
 const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
 const codes={film:'f2ff',close:'f24e',add:'f107',search:'f563',next:'f23b',back:'f22d',check:'f21f',folder:'f327',refresh:'f518',expand:'f2e1',contract:'f28a',play:'f4d6',pause:'f497',note:'f20d',file:'f2b4',more:'f2ce',offline:'f25b',error:'f114'};
 const icon=name=>pawsPrototype.icon(codes[name]);
 const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const storageKey='paws-motion-entry-projects-v1';
 let saved={};try{const value=JSON.parse(localStorage.getItem(storageKey)||'{}');if(value&&typeof value==='object')saved=value;}catch{}
 const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(saved));}catch{pawsPrototype.toast('浏览器未允许保存；当前演示内容仍保留在页面里。');}};
 const projects=[{id:'paws-film',title:'Paws 宣传片',duration:8.5,updated:'今天 14:32',recent:true},{id:'product-tour',title:'产品功能演示',duration:15,updated:'昨天 18:10'},{id:'social-intro',title:'社媒开场短片',duration:12,updated:'11 月 24 日 16:45'}];
 let scenario='multiple',current=null,notesOpen=false,noteDraft='',noteSaved='',time=0,operation=0,loadAnimation=null,playing=false,playGeneration=0,attempt=0,emptyProjects=[];
 const pending=()=>notesOpen&&noteDraft!==noteSaved;
 const title=p=>saved[p.id]?.title||p.title;
 const duration=()=>current?.duration||8.5;
 const frameTime=()=>`${time.toFixed(1)}s`;
 const flowSteps=(step=1)=>$('.flow-steps').innerHTML=[['01','查看工程'],['02','自动准备'],['03','进入剪辑']].map(([n,text],i)=>`<span class="${i+1===step?'current':''}">${n} ${text}</span>${i<2?'<span>›</span>':''}`).join('');
 const note=$('.review-note');note.className='review-note flow-steps';flowSteps();
 const actions=$('.review-actions');
 actions.insertAdjacentHTML('afterbegin','<select id="scenario" aria-label="演练场景"><option value="multiple">完整流程 · 多个工程</option><option value="single">只有一个工程</option><option value="empty">首次使用 · 无工程</option><option value="failure">启动失败后重试</option><option value="offline">执行机离线</option><option value="partial">查找结果不完整</option></select><button id="simulate-created" class="create-sim" hidden>完成创建（演示）</button>');
 const entry=document.createElement('button');entry.className='editing-trigger';entry.id='editing-entry';entry.setAttribute('aria-haspopup','dialog');entry.setAttribute('aria-expanded','false');entry.setAttribute('aria-label','剪辑');entry.innerHTML=icon('film')+'剪辑';
 const header=$('#source-header>div');header.insertBefore(entry,header.lastElementChild);
 const intro=$('.message:not(.user)');intro.innerHTML=`<div class="meta">${icon('check')} Codex · 已完成</div><h2>继续打开已保存的影片</h2><p>点击会话右上角的「剪辑」，就能按工程名找到影片。</p><p>打开后可以查看画布和时间线；修改要求仍在当前对话里继续。</p><div class="flow-guide"><b>从这里开始</b> ${icon('next')} 右上角「剪辑」 ${icon('next')} 选择影片 ${icon('next')} 进入工作台</div>`;
 const dialogShell=(id,name)=>{const d=document.createElement('dialog');d.className='flow-dialog';d.id=id;d.setAttribute('aria-label',name);d.addEventListener('click',e=>{const r=d.getBoundingClientRect();if(e.target===d&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))d.close();});d.addEventListener('close',()=>{if(d===library){entry.setAttribute('aria-expanded','false');flowSteps(current?3:1);}d._returnFocus?.isConnected&&d._returnFocus.focus();});document.body.append(d);return d;};
 const library=dialogShell('project-library','影片工程'), addDialog=dialogShell('add-project','添加已有工程'), guard=dialogShell('unsaved-note','保存未完成的标注'), rename=dialogShell('rename-project','工程名称');
 const show=(d,html,focus)=>{d.innerHTML=html;d._returnFocus=document.activeElement;if(!d.open)d.showModal();d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());(d.querySelector(focus)||d.querySelector('button'))?.focus();};
 const heading=(text)=>`<header class="dialog-head"><h2>${text}</h2><button class="icon-button" data-close aria-label="关闭${text}">${icon('close')}</button></header>`;
 const getProjects=()=>scenario==='empty'?emptyProjects:scenario==='single'||scenario==='partial'?[projects[0]]:projects;
 function renderList(query=''){
  const list=getProjects(),filtered=list.filter(p=>title(p).toLowerCase().includes(query.toLowerCase().trim()));
  $('#project-list').innerHTML=filtered.length?filtered.map(p=>`<button class="project-row" data-project="${p.id}" aria-label="打开 ${escape(title(p))}"><span class="project-symbol">${icon('film')}</span><span class="project-row-copy"><span class="project-row-title">${escape(title(p))}</span><span class="project-row-meta">${p.duration} 秒 · 修改于 ${p.updated}</span></span>${p.recent?'<span class="recent-tag">最近打开</span>':''}${icon('next')}</button>`).join(''):`<div class="empty-state"><div class="big-icon">${icon('film')}</div><h3>${list.length?'没有匹配的影片工程':'还没有影片工程'}</h3><p>${list.length?'换个名称试试，或清空搜索查看全部工程。':'让 AI 创建第一条影片，或添加这个工作目录里的已有工程。'}</p>${list.length?'<button class="flow-button secondary" id="clear-filter">清空搜索</button>':''}</div>`;
  library.querySelectorAll('[data-project]').forEach(b=>b.onclick=()=>confirmUnsaved(()=>openProject(projects.find(p=>p.id===b.dataset.project))));
  $('#clear-filter')?.addEventListener('click',()=>{$('#project-search').value='';renderList();$('#project-search').focus();});
 }
 function openLibrary(force=false){
  if(scenario==='offline')return;
  const list=getProjects();
  if(!force&&list.length===1&&scenario!=='partial'){confirmUnsaved(()=>openProject(list[0]));return;}
  show(library,heading('影片工程')+`<div class="dialog-body"><p class="scope-line">${icon('folder')} 当前工作目录：<span class="scope-name">品牌影片</span></p><div class="project-search">${icon('search')}<input id="project-search" aria-label="搜索影片工程" placeholder="搜索工程名称" autocomplete="off"></div><div class="project-list" id="project-list"></div>${scenario==='partial'?'<div class="partial-notice">这次只找到部分工程。可添加更深层目录中的工程，或刷新列表。</div>':''}<footer class="dialog-footer"><button class="flow-button primary" id="create-film">${icon('add')}让 AI 创建影片</button><button class="flow-button" id="add-existing">${icon('folder')}添加已有工程</button><button class="flow-button" id="refresh-projects" style="margin-left:auto">${icon('refresh')}刷新</button></footer></div>`,'#project-search');
  renderList();entry.setAttribute('aria-expanded','true');flowSteps(1);
  $('#project-search').oninput=e=>renderList(e.target.value);
  $('#refresh-projects').onclick=()=>{renderList($('#project-search').value);pawsPrototype.toast('工程列表已刷新（演示）。');};
  $('#add-existing').onclick=()=>{library.close();openAdd();};
  $('#create-film').onclick=()=>{library.close();appendMessage('请在当前工作目录里创建一个新的影片工程。','user');appendMessage('先告诉我这条影片想介绍什么，以及大概的时长。已有工程会保留。');$('#simulate-created').hidden=scenario!=='empty';pawsPrototype.toast('创建要求已展示在当前会话。本稿不会调用真实 AI。');};
 }
 entry.onclick=()=>{if(library.open)library.close();else openLibrary();};
 function openAdd(){
  show(addDialog,heading('添加已有工程')+`<form class="dialog-body" id="add-form"><p>添加当前工作目录内的影片工程。</p><label>工程文件夹<input class="flow-input" id="project-folder" aria-label="工程文件夹" placeholder="例如：已有影片" autocomplete="off" required></label><p class="form-error" id="folder-error" hidden></p><footer class="dialog-footer"><button class="flow-button" type="button" data-close>取消</button><button class="flow-button primary" type="submit">添加并打开</button></footer></form>`,'#project-folder');
  $('#add-form').onsubmit=e=>{e.preventDefault();const folder=$('#project-folder').value.trim();if(!folder)return; if(folder.startsWith('/')||folder.split(/[\\/]/).includes('..')){const error=$('#folder-error');error.textContent='请选择当前工作目录内的工程文件夹。';error.hidden=false;return;}
   const p={id:'imported-'+projects.length,title:folder.split(/[\\/]/).filter(Boolean).pop(),duration:10,updated:'刚刚'};projects.push(p);if(scenario==='empty')emptyProjects.push(p);addDialog.close();confirmUnsaved(()=>openProject(p));};
 }
 function confirmUnsaved(next){
  if(!pending()){next();return;}
  show(guard,heading('标注还没有保存')+`<div class="dialog-body"><p>先保存这条标注，再离开当前工程？</p><footer class="dialog-footer"><button class="flow-button" data-close>留在这里</button><button class="flow-button destructive" id="discard-note">放弃本次编辑</button><button class="flow-button primary" id="save-and-continue">保存并继续</button></footer></div>`,'[data-close]');
  $('#discard-note').onclick=()=>{noteDraft=noteSaved;guard.close();next();};
  $('#save-and-continue').onclick=()=>{saveNote();guard.close();next();};
 }
 function stop(){playing=false;playGeneration++;$('#play-demo')?.setAttribute('aria-label','播放画面示意');if($('#play-demo'))$('#play-demo').innerHTML=icon('play');}
 function disposeEditor(){operation++;loadAnimation?.cancel();stop();$('#editor-panel')?.remove();$('#workspace-shell').classList.remove('editing','is-max');current=null;notesOpen=false;$('#capabilities').innerHTML=originalCapabilities;flowSteps(1);}
 const originalCapabilities=$('#capabilities').innerHTML;
 function closeEditor(){confirmUnsaved(()=>{disposeEditor();entry.focus();});}
 function renderFileTree(){
  $('#capabilities').innerHTML=`<div class="cap-tabs"><button class="selected">${icon('folder')}文件</button></div><div class="sidebar-file-tree"><h3>品牌影片</h3><div class="file-tree-row">${icon('folder')} ${escape(title(current))}</div><div class="file-tree-row active indent">${icon('film')} 影片工程</div><div class="file-tree-row indent">${icon('folder')} 素材</div><div class="file-tree-row indent">${icon('file')} 工程说明</div><div class="file-tree-hint">按工程名打开即可继续编辑，无需在文件树里寻找配置文件。</div></div>`;
 }
 function editorHeader(){return `<header class="editor-header">${icon('film')}<button class="editor-project-title" id="rename-current" aria-label="修改工程名称">${escape(title(current))}</button><span class="save-state" id="save-state">已保存</span><button class="icon-button" id="expand-editor" aria-label="放大剪辑区">${icon('expand')}</button><button class="icon-button" id="close-editor" aria-label="关闭剪辑区">${icon('close')}</button></header>`;}
 function wireEditorHeader(){
  $('#close-editor').onclick=closeEditor;$('#rename-current').onclick=openRename;
  $('#expand-editor').onclick=()=>{const maximized=$('#workspace-shell').classList.toggle('is-max');$('#expand-editor').innerHTML=icon(maximized?'contract':'expand');$('#expand-editor').setAttribute('aria-label',maximized?'恢复并排查看':'放大剪辑区');};
 }
 function openProject(project){
  if(!project)return;library.open&&library.close();addDialog.open&&addDialog.close();operation++;loadAnimation?.cancel();stop();
  current=project;notesOpen=false;noteDraft=noteSaved=saved[current.id]?.note||'';time=Math.min(saved[current.id]?.time||1.6,duration());
  $('#workspace-shell').classList.add('editing');let panel=$('#editor-panel');if(!panel){panel=document.createElement('section');panel.id='editor-panel';panel.className='editor-panel';panel.setAttribute('aria-label','剪辑工作台');$('#workspace-shell').insertBefore(panel,$('#capabilities'));}
  renderFileTree();beginOpen();
 }
 function beginOpen(){
  const token=++operation;attempt++;flowSteps(2);const panel=$('#editor-panel');panel.dataset.state='opening';panel.innerHTML=editorHeader()+`<div class="editor-body"><div class="opening-state"><div class="opening-copy"><div class="opening-symbol">${icon('film')}</div><h3>正在准备剪辑工作台</h3><p>服务会自动准备。工程打开后，画布和时间线会显示在这里。</p><div class="opening-progress"><span id="open-progress"></span></div><div class="opening-steps"><span>准备工程</span><span>加载画面与素材</span><span>恢复时间线</span></div><div class="opening-actions" style="margin-top:22px"><button class="flow-button secondary" id="cancel-opening">取消打开</button></div></div></div></div>`;
  wireEditorHeader();$('#cancel-opening').onclick=closeEditor;
  loadAnimation=$('#open-progress').animate([{transform:'scaleX(.03)'},{transform:'scaleX(1)'}],{duration:matchMedia('(prefers-reduced-motion:reduce)').matches?200:1100,easing:'ease-out',fill:'forwards'});
  loadAnimation.finished.then(()=>{if(token!==operation||!current)return;if(scenario==='failure'&&attempt===1)renderError();else renderReady();}).catch(()=>{});
 }
 function renderError(){
  const panel=$('#editor-panel');panel.dataset.state='error';panel.querySelector('.editor-body').innerHTML=`<div class="opening-state"><div class="opening-copy"><div class="opening-symbol empty-error">${icon('error')}</div><h3>工作台暂时没能打开</h3><p>工程和当前对话仍在。可以重新尝试打开，或返回工程列表。</p><div class="opening-actions"><button class="flow-button primary" id="retry-opening">重新打开</button><button class="flow-button secondary" id="back-library">返回工程列表</button></div></div></div>`;
  $('#retry-opening').onclick=beginOpen;$('#back-library').onclick=()=>openLibrary(true);
 }
 function renderReady(){
  const panel=$('#editor-panel');panel.dataset.state='ready';panel.innerHTML=editorHeader()+`<div class="editor-body"><div class="editor-toolbar"><button class="flow-button open-library" id="back-library">${icon('folder')}工程列表</button><span class="spacer"></span><button class="flow-button" id="add-annotation" aria-expanded="false">${icon('note')}AI 标注</button><span class="save-state">${current.duration}s</span></div><div class="preview-region"><div class="preview-label"><span id="scene-label">首屏飞行</span><span>工程画面示意</span></div><div class="preview-stage"><div class="film-frame" id="film-frame"><div class="film-logo">Paws</div><div class="film-tail">Keep your ideas moving.</div><div class="film-page"><b>Your agents. In your hands.</b><span></span><span></span><i></i></div><div class="film-float"></div><div class="annotation-pin" id="annotation-pin" hidden>1</div></div></div></div><div class="transport"><button id="play-demo" aria-label="播放画面示意">${icon('play')}</button><time id="current-time"></time><input type="range" min="0" max="${duration()}" step="0.1" value="${time}" aria-label="播放位置" id="playhead"><time>${duration().toFixed(1)}s</time></div><div class="timeline" aria-label="影片时间线"><div class="timeline-ruler"><span>0s</span><span>${(duration()/3).toFixed(1)}s</span><span>${(duration()*2/3).toFixed(1)}s</span><span>${duration()}s</span></div><div class="track"><span class="track-name">场景</span><div class="track-strips"><button class="clip" style="flex:3" data-seek="0">首屏飞行</button><button class="clip" style="flex:3" data-seek="2.5">页面浏览</button><button class="clip" style="flex:4" data-seek="6.5">结尾卡片</button></div></div><div class="track"><span class="track-name">浮起元素</span><div class="track-strips"><span class="clip" style="width:45%">卡片与照片</span><span class="clip" style="width:30%">品牌图标</span></div></div><div class="track"><span class="track-name">声音</span><div class="track-strips"><div class="clip audio"><span>底乐 · 落点</span></div></div></div></div><section class="editor-notes" id="editor-notes" aria-label="AI 标注" hidden></section></div>`;
  wireEditorHeader();$('#back-library').onclick=()=>openLibrary(true);$('#add-annotation').onclick=toggleNotes;
  $('#playhead').oninput=e=>{stop();seek(Number(e.target.value),true);};
  $$('[data-seek]').forEach(b=>b.onclick=()=>{stop();seek(Math.min(Number(b.dataset.seek),duration()),true);});
  $('#play-demo').onclick=togglePlay;
  seek(time);$('#annotation-pin').hidden=!noteSaved.trim();flowSteps(3);$('#rename-current').focus();
 }
 function seek(value,persist=false){
  time=Math.max(0,Math.min(value,duration()));if(!$('#current-time'))return;$('#current-time').textContent=frameTime();$('#playhead').value=String(time);
  const end=time>=duration()*.72;$('#scene-label').textContent=end?'结尾卡片':time>2.2?'页面浏览':'首屏飞行';$('#film-frame').classList.toggle('end-card',end);
  $('#film-frame .film-page').style.transform=end?'none':`perspective(600px) rotateX(${36-time*4}deg) translateY(${12-time*4}px)`;
  if(persist&&current){saved[current.id]={...saved[current.id],time};save();}
 }
 function togglePlay(){
  if(playing){stop();return;}playing=true;const token=++playGeneration,start=performance.now(),from=time>=duration()?0:time;$('#play-demo').innerHTML=icon('pause');$('#play-demo').setAttribute('aria-label','暂停画面示意');
  const frame=now=>{if(token!==playGeneration||!playing||!current)return;seek(from+(now-start)/1000);if(time>=duration()){stop();seek(time,true);return;}requestAnimationFrame(frame);};requestAnimationFrame(frame);
 }
 function toggleNotes(){
  if(notesOpen){if(pending()){confirmUnsaved(()=>{notesOpen=false;$('#editor-notes').hidden=true;$('#add-annotation').setAttribute('aria-expanded','false');});return;}notesOpen=false;$('#editor-notes').hidden=true;$('#add-annotation').setAttribute('aria-expanded','false');return;}
  notesOpen=true;$('#add-annotation').setAttribute('aria-expanded','true');$('#editor-notes').hidden=false;$('#editor-notes').innerHTML=`<div class="notes-head">${icon('note')} AI 标注<span id="note-status">${noteSaved?'已保存':'在 '+frameTime()+' 添加要求'}</span></div><textarea id="annotation-text" aria-label="标注修改要求" placeholder="例如：保留第一行文案，让结尾的推进更明显。">${escape(noteDraft)}</textarea><div class="notes-actions"><button class="flow-button secondary" id="save-note">保存标注</button><button class="flow-button primary" id="send-note">发送到当前会话</button></div>`;
  $('#annotation-text').oninput=e=>{noteDraft=e.target.value;$('#note-status').textContent=pending()?'未保存':'已保存';$('#save-state').textContent=pending()?'标注未保存':'已保存';$('#save-note').disabled=!noteDraft.trim();$('#send-note').disabled=!noteDraft.trim();};
  $('#save-note').disabled=!noteDraft.trim();$('#send-note').disabled=!noteDraft.trim();$('#annotation-text').focus();$('#save-note').onclick=()=>{saveNote();pawsPrototype.toast('标注已保存在此浏览器的演示工程中。');};$('#send-note').onclick=sendNote;
 }
 function saveNote(){if(!current)return;noteSaved=noteDraft;saved[current.id]={...saved[current.id],note:noteSaved,time};save();if($('#save-state'))$('#save-state').textContent='已保存';if($('#note-status'))$('#note-status').textContent='已保存 · '+frameTime();if($('#annotation-pin'))$('#annotation-pin').hidden=!noteSaved.trim();}
 function sendNote(){if(!noteDraft.trim())return;saveNote();appendMessage(`${title(current)} · ${frameTime()}\n${noteDraft}`,'user');if($('#note-status'))$('#note-status').textContent='已加入会话 · 演示';pawsPrototype.toast('演示：修改要求已展示在当前会话，未调用真实 AI。');}
 function appendMessage(text,kind='assistant'){const node=document.createElement('div');node.className='message '+(kind==='user'?'user':'');node.style.whiteSpace='pre-wrap';node.textContent=text;$('#conversation').append(node);node.scrollIntoView({block:'end'});}
 function openRename(){
  if(!current)return;show(rename,heading('工程名称')+`<form class="dialog-body" id="rename-form"><label>工程名称<input id="project-title" class="flow-input" aria-label="工程名称" maxlength="200" value="${escape(title(current))}" required></label><footer class="dialog-footer"><button class="flow-button" type="button" data-close>取消</button><button class="flow-button primary" type="submit">保存名称</button></footer></form>`,'#project-title');
  $('#rename-form').onsubmit=e=>{e.preventDefault();const next=$('#project-title').value.trim();if(!next)return;saved[current.id]={...saved[current.id],title:next};save();$('#rename-current').textContent=next;renderFileTree();rename.close();};
 }
 function setScenario(next){
  library.open&&library.close();addDialog.open&&addDialog.close();rename.open&&rename.close();disposeEditor();scenario=next;$('#scenario').value=next;attempt=0;emptyProjects=[];entry.disabled=next==='offline';entry.title=next==='offline'?'执行机离线，连接恢复后可打开工程':'按名称查看影片工程';$('#simulate-created').hidden=next!=='empty';$('.flow-offline')?.remove();if(next==='offline')entry.insertAdjacentHTML('afterend','<span class="flow-offline">执行机离线</span>');
 }
 $('#scenario').onchange=e=>{const next=e.target.value;e.target.value=scenario;confirmUnsaved(()=>setScenario(next));};
 $('#simulate-created').onclick=()=>{emptyProjects=[projects[0]];$('#simulate-created').hidden=true;pawsPrototype.toast('已模拟创建完成。再次点击「剪辑」会直接打开新工程。');};
 const composer=$('.source-composer textarea'),send=$('.source-composer button[aria-label="发送演示消息"]');
 const syncSend=()=>send.disabled=!composer.value.trim();syncSend();composer.addEventListener('input',syncSend);
 send.onclick=()=>{if(!composer.value.trim())return;appendMessage(composer.value.trim(),'user');composer.value='';try{localStorage.removeItem(pawsPrototype.draftKey);}catch{}syncSend();pawsPrototype.toast('演示消息已显示，不会发送到真实会话。');};
 composer.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send.click();}});
 const theme=$('#theme-select');theme.addEventListener('change',()=>{document.body.dataset.previewTheme=theme.value||'current';});
 document.body.dataset.flowReady='true';
})();
