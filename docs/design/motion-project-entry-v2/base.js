(() => {
 const icon=(code,family='ionicons')=>`<span class="icon ${family==='feather'?'feather':''}" aria-hidden="true">&#x${code};</span>`;
 const baseline=document.body.dataset.version==='baseline';
 const row=(title,folder,active=false)=>`<div class="sample-session ${active?'active':''}">${PawsSourceFragments.row.replaceAll('__TITLE__',title).replaceAll('__FOLDER__',folder)}</div>`;
 document.querySelector('#root').innerHTML=`
 <div class="review-bar" aria-label="交互稿评审工具"><div class="review-brand">Paws / 工程入口<span>原位交互稿 · 演示数据</span></div><div class="review-note">已复用原标题栏与输入区 · 不包含私人照片和历史正文</div><div class="review-actions"><button id="baseline-link" class="${baseline?'active':''}">原界面底稿</button><button id="design-link" class="${!baseline?'active':''}">完整流程</button><select aria-label="预览主题" id="theme-select"><option value="">当前深色</option><option value="light">浅色</option><option value="gingham">Gingham 深色</option></select></div></div>
 <div class="app-shell" id="product-shell">
  <nav class="rail" aria-label="主导航"><button class="selected" aria-label="主页">${icon('f383')}</button><button aria-label="Bots">${icon('f365')}</button><button aria-label="定时任务">${icon('f5de')}</button><hr><button aria-label="全部项目">${icon('f327')}</button><button aria-label="插件">${icon('f2e4')}</button><button aria-label="全局会话">${icon('f318')}</button><div class="rail-bottom"><button aria-label="演示账号"><span class="account-dot">P</span></button><button aria-label="帮助">${icon('f37e')}</button></div></nav>
  <aside class="session-sidebar" aria-label="会话列表"><div class="side-head">Paws<div class="side-tools"><button aria-label="清单">${icon('f191')}</button><button aria-label="通知">${icon('f125')}</button><button aria-label="搜索会话">${icon('f375')}</button></div></div><button class="new-session">${icon('f15f')} 新建会话</button><div class="section-label">优先事项</div>${row('品牌宣传片','品牌影片',true)}${row('产品介绍视频','产品演示')}${row('网站动效探索','设计工作区')}<div class="section-label">今天</div>${row('落地页文案优化','品牌网站')}${row('功能演示片','产品演示')}${row('封面与配色','设计工作区')}<div class="section-label">更早</div>${row('品牌素材整理','品牌影片')}</aside>
  <div class="workspace-shell" id="workspace-shell"><main class="chat-panel" aria-label="当前会话"><div class="source-header" id="source-header">${PawsSourceFragments.header}</div><div class="conversation" id="conversation"><div class="message user">我想继续调整这条宣传片。之前做的影片工程在哪里打开？</div><article class="message"><div class="meta">${icon('f532')} Codex · 已完成</div><h2>影片已保存在当前工作目录</h2><p>可以继续查看画面、调整时间线，或在具体时刻添加 AI 标注。</p><p>你对节奏和文案的修改要求会留在这个会话里。</p><div class="small-hint">当前画面使用演示工程与示例对话。</div></article><div class="activity-line">${icon('f2d0')} 已保存影片工程与素材</div></div><div class="composer-wrap"><div class="composer-state"><span class="status-dot"></span> 已完成</div><div class="source-composer" id="source-composer">${PawsSourceFragments.composer}</div></div></main>
  <aside class="capabilities" id="capabilities" aria-label="能力中心"><div class="cap-tabs"><button class="selected">${icon('f58d')} 能力中心</button><button>${icon('f329')} 文件</button><button class="collapse">收起 ›</button></div><div class="cap-content"><h2>能力中心</h2><div class="cap-grid">${[['f58d','1','输出','品牌宣传片.mp4'],['f3b9','0','来源','当前任务使用的链接和附件'],['f2d0','8','会话操作','归档会话 · 会话详情'],['f31a','4','Skills','动效制作与视觉检查'],['f213','6','快捷指令','继续修改当前工程'],['f38f','0','生成图片',''],['f329','3','文件夹','品牌影片 · 产品演示'],['f172','4','文件','工程说明与素材清单']].map(([glyph,count,title,desc])=>`<div class="cap-card"><div class="cap-stat">${icon(glyph)}<b>${count}</b></div><strong>${title}</strong><p>${desc}</p></div>`).join('')}</div></div></aside></div>
 </div><div class="prototype-toast" id="toast" role="status" hidden></div>`;
 window.pawsPrototype={icon,toast(text){const e=document.querySelector('#toast');e.textContent=text;e.hidden=false;},draftKey:'paws-motion-entry-prototype-draft-v1'};
 document.querySelector('.side-tools').innerHTML=`<button aria-label="清单">${icon('f191','feather')}</button><button aria-label="时间线">${icon('f11e','feather')}</button><button aria-label="会话管理">${icon('f1d0','feather')}</button>`;
 document.querySelector('.new-session').innerHTML=icon('f15f','feather')+' 新建会话';
 for(let e=document.querySelector('[data-baseline-title]').parentElement;e&&e!==document.querySelector('#source-header>div');e=e.parentElement)e.style.setProperty('width','100%');
 const input=document.querySelector('.source-composer textarea');
 input.setAttribute('aria-label','当前会话消息');input.placeholder='输入修改要求…';
 try{input.value=localStorage.getItem(pawsPrototype.draftKey)||'';}catch{}
 input.addEventListener('input',()=>{try{localStorage.setItem(pawsPrototype.draftKey,input.value);}catch{}});
 document.querySelector('#theme-select').addEventListener('change',e=>{document.body.classList.remove('light','gingham');if(e.target.value)document.body.classList.add(e.target.value);});
 document.querySelector('#baseline-link').onclick=()=>{location.href='baseline.html';};
 document.querySelector('#design-link').onclick=()=>{location.href='index.html';};
 document.querySelectorAll('.rail button,.side-tools button,.new-session,.sample-session button,.cap-tabs button,.source-header button').forEach(b=>{b.onclick=()=>pawsPrototype.toast('这部分保留原界面外观；本稿演示剪辑工程的打开流程。');});
 document.querySelectorAll('.source-composer button').forEach(b=>{b.onclick=()=>pawsPrototype.toast('静态交互稿：此处不会向真实 AI 发送消息。');});
 document.querySelector('#toast').onclick=()=>document.querySelector('#toast').hidden=true;
 document.body.dataset.ready='true';
})();
