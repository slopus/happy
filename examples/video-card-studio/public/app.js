import { readArchiveBlob } from './download.mjs';
const $ = id => document.getElementById(id);
const statuses = { queued: '排队等待制作', dispatching: '正在提交到 Paws', waiting: 'Paws 已收到，等待制作机器领取', processing: '正在制作', completed: '制作完成', failed: '本次制作未完成', uncertain: '执行中断，等待管理员核对' };
const phases = { source: '读取原视频', transcript: '识别原话', proofread: '对照画面核对字幕', plan: '精选完整观点', frames: '提取原画面', selection: '挑选清晰画面', cards: '排版长图', archive: '保存图片', upload: '上传成品' };
const stages = [
  { label: '接收任务', phases: ['queued'] },
  { label: '读取视频', phases: ['source'] },
  { label: '整理原话', phases: ['transcript', 'proofread', 'plan'] },
  { label: '生成卡片', phases: ['frames', 'selection', 'cards', 'archive', 'upload'] },
];
const timestamp = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const errors = { 'invalid-video': '请输入公开单 P 的 B 站视频链接或完整 BV 号。', 'queue-full': '制作队列已满，请稍后再提交。', 'rate-limit': '提交得有些快，请稍后再试。', 'idempotency-conflict': '这次提交的链接已变化，请重新提交。' };
const trackedJob = () => /^#(?:job|result)-([a-f0-9-]{36})$/.exec(window.location.hash)?.[1];
let stream, request = null, galleryFingerprint = '[]';
let currentId = trackedJob();
let initialAnchor = currentId ? window.location.hash.slice(1) : '';
const unobservedJobs = new Map();
let pageState = { connection: 'disconnected', jobs: [] };
let downloading = false, downloadController;
const downloadURLs = new Map();
window.addEventListener('pagehide', () => { downloadController?.abort(); for (const [url, timer] of downloadURLs) { clearTimeout(timer); URL.revokeObjectURL(url); } downloadURLs.clear(); });
async function downloadBundle(job, button, feedback) {
  if (downloading) { feedback.textContent = '另一组下载正在准备，请稍等。'; return; }
  downloading = true; button.disabled = true; feedback.className = 'download-feedback'; feedback.textContent = '正在读取完整压缩包…';
  downloadController = new AbortController();
  try {
    const blob = await readArchiveBlob(`/api/jobs/${job.id}/cards.zip`, { signal: AbortSignal.any([downloadController.signal, AbortSignal.timeout(120000)]) });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${job.bvid}-cards.zip`; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove();
    // One-shot resource cleanup, never a status query or reconnect loop.
    const timer = setTimeout(() => { URL.revokeObjectURL(url); downloadURLs.delete(url); }, 30000);
    downloadURLs.set(url, timer);
    feedback.textContent = '已交给浏览器保存，请查看下载记录。';
  } catch { feedback.className = 'download-feedback error'; feedback.textContent = '下载未完成，请重新点击。'; }
  finally { downloading = false; downloadController = null; button.disabled = false; }
}
function el(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function link(text, href, className) { const a = el('a', className, text); a.href = href; return a; }
function time(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function jobStatus(job) {
  if (job.state === 'processing') return phases[job.phase] ?? statuses.processing;
  if (job.state === 'failed' && job.phase === 'source') return '读取原视频失败';
  return statuses[job.state] ?? '等待更新';
}
function terminal(job) { return job.state === 'completed' || job.state === 'failed'; }
function needsAttention(job) { return job.state === 'failed' || job.state === 'uncertain'; }
function submittedAt(job) { return Number.isFinite(job.createdAt) ? `提交于 ${timestamp.format(job.createdAt)}` : ''; }
function sourceLink(job, style) {
  const source = link('查看原视频', job.url, style);
  source.target = '_blank'; source.rel = 'noopener noreferrer';
  return source;
}
function renderJob(job, knownTitles) {
  const row = el('article', `job-row${job.id === currentId ? ' selected' : ''}${needsAttention(job) ? ' job-error' : ''}`);
  row.id = `job-${job.id}`; row.dataset.jobId = job.id;
  const heading = el('div', 'job-heading'), identity = el('div');
  const title = job.manifest?.title ?? knownTitles.get(job.bvid);
  identity.append(el('h3', 'job-title', title ?? job.bvid));
  identity.append(el('p', 'job-meta', [title && job.bvid, submittedAt(job), job.runId && '已触发 Paws'].filter(Boolean).join(' · ')));
  const stateLabel = { processing: '制作中', completed: '已完成', failed: '制作失败', uncertain: '待核对' }[job.state] ?? '等待中';
  const badgeClass = job.state === 'processing' ? 'active' : job.state === 'completed' ? 'complete' : needsAttention(job) ? 'error' : '';
  heading.append(identity, el('span', `job-badge ${badgeClass}`, stateLabel));
  const status = el('p', 'job-state', jobStatus(job));
  if (job.id !== currentId) status.setAttribute('role', 'status');
  row.append(heading, status);
  if (!terminal(job)) {
    const steps = el('ol', 'job-steps'); steps.setAttribute('aria-label', '制作阶段');
    const stage = Math.max(0, stages.findIndex(step => step.phases.includes(job.phase)));
    for (const [index, step] of stages.entries()) {
      const item = el('li', '', step.label);
      item.dataset.state = index < stage ? 'done' : index === stage ? 'current' : 'pending';
      if (index === stage) item.setAttribute('aria-current', 'step');
      steps.append(item);
    }
    row.append(steps);
  }
  const actions = el('div', 'job-actions');
  if (job.manifest && job.state === 'completed') actions.append(link('查看本次成品', `#result-${job.id}`, 'result-link'));
  actions.append(sourceLink(job, 'job-source'));
  row.append(actions);
  return row;
}
function renderHistory(jobs, knownTitles) {
  $('history').hidden = !jobs.length;
  $('history-label').textContent = `历史任务（${jobs.length}）`;
  const history = $('history-list'); history.replaceChildren();
  for (const job of jobs) {
    const row = el('div', 'history-row'); const meta = el('div');
    meta.append(el('p', 'job-title', job.manifest?.title ?? knownTitles.get(job.bvid) ?? job.bvid));
    meta.append(el('p', 'job-meta', [submittedAt(job), jobStatus(job)].filter(Boolean).join(' · ')));
    const action = job.state === 'completed' && job.manifest
      ? link('查看成品', `#result-${job.id}`, 'result-link') : sourceLink(job, 'job-source');
    row.append(meta, action); history.append(row);
  }
}
function render(state) {
  pageState = state;
  const incomingIds = new Set(state.jobs.map(job => job.id));
  const jobs = [...Array.from(unobservedJobs.values()).reverse().filter(job => !incomingIds.has(job.id)), ...state.jobs];
  $('connection-label').textContent = state.connection === 'closed' ? '页面连接已断开，制作记录仍会保留'
    : state.connection === 'connected' ? '制作通道已连接' : '制作通道暂未连接，提交会保留';
  const current = jobs.find(job => job.id === currentId);
  if (current && !request) {
    const feedback = $('form-feedback');
    feedback.className = needsAttention(current) ? 'feedback error' : 'feedback';
    feedback.textContent = `${current.bvid} · ${jobStatus(current)}`;
  }
  const active = jobs.filter(job => !terminal(job));
  const count = $('queue-count'); count.textContent = String(active.length); count.hidden = !active.length;
  const finished = jobs.filter(job => job.state === 'completed' && job.manifest);
  const titles = new Map();
  for (const job of finished) if (!titles.has(job.bvid)) titles.set(job.bvid, job.manifest.title);
  const visible = current ? [current, ...active.filter(job => job.id !== current.id)] : active;
  const queue = $('queue'); queue.replaceChildren();
  if (!visible.length) queue.append(el('p', 'muted', '当前没有制作中的任务。'));
  for (const job of visible) queue.append(renderJob(job, titles));
  renderHistory(jobs.filter(job => terminal(job) && job.id !== currentId), titles);
  renderGallery(finished);
  const anchor = initialAnchor && $(initialAnchor);
  if (anchor) { initialAnchor = ''; anchor.scrollIntoView(); }
}
function renderGallery(finished) {
  const fingerprint = JSON.stringify(finished);
  if (fingerprint === galleryFingerprint) return;
  galleryFingerprint = fingerprint; const gallery = $('gallery'); gallery.replaceChildren();
  if (!finished.length) gallery.append(el('p', 'empty', '卡片制作完成后会显示在这里。'));
  for (const job of finished) {
    const group = el('section', 'result'), heading = el('div', 'result-heading'), title = el('div');
    group.id = `result-${job.id}`;
    title.append(el('h3', '', job.manifest.title));
    const source = link(`${job.manifest.author} · ${job.bvid} · 自动转写，待核对`, job.url, 'result-source'); source.target = '_blank'; source.rel = 'noopener noreferrer'; title.append(source);
    title.append(el('p', 'result-meta', submittedAt(job)));
    const downloadArea = el('div', 'download-area'), bundle = el('button', 'download-all', `整组下载 · ${job.manifest.cards.length} 张`), feedback = el('p', 'download-feedback');
    bundle.type = 'button'; bundle.dataset.jobId = job.id; feedback.setAttribute('role', 'status');
    bundle.onclick = () => void downloadBundle(job, bundle, feedback);
    downloadArea.append(bundle, feedback); heading.append(title, downloadArea); group.append(heading);
    const cards = el('div', 'cards');
    for (const [index, card] of job.manifest.cards.entries()) {
      const number = index + 1;
      const url = `/api/jobs/${job.id}/${card.file}`;
      const figure = el('figure', 'card');
      const cardHeading = el('div', 'card-heading');
      const sourceTime = link(`${time(card.start)}–${time(card.end)}`, `${job.url}?t=${Math.floor(card.start)}`, 'card-time'); sourceTime.target = '_blank'; sourceTime.rel = 'noopener noreferrer';
      cardHeading.append(el('strong', 'card-index', `第 ${number} 张`), sourceTime);

      const preview = link('', url, 'card-preview');
      preview.target = '_blank'; preview.rel = 'noopener';
      preview.setAttribute('aria-label', `查看第 ${number} 张原图`);
      const img = el('img');
      img.src = url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      preview.append(img);

      const caption = el('figcaption');
      const actions = el('div', 'card-actions');
      const original = link('查看原图', url, 'card-original');
      original.target = '_blank'; original.rel = 'noopener';
      original.setAttribute('aria-label', `查看第 ${number} 张原图`);
      const download = link('下载 PNG', url, 'card-download');
      download.download = `${job.bvid}-${card.file}`;
      download.setAttribute('aria-label', `下载第 ${number} 张 PNG`);
      actions.append(original, download);
      caption.append(el('p', 'card-quote', card.quote), actions);
      figure.append(cardHeading, preview, caption);
      cards.append(figure);
    }
    group.append(cards); gallery.append(group);
  }
}
function connect() {
  stream?.close(); $('reconnect').hidden = true; stream = new EventSource('/api/events');
  stream.addEventListener('state', event => {
    const state = JSON.parse(event.data);
    for (const job of state.jobs) unobservedJobs.delete(job.id);
    render(state);
  });
  stream.onerror = () => { stream.close(); render({ ...pageState, connection: 'closed' }); $('reconnect').hidden = false; };
}
$('reconnect').onclick = connect;
window.addEventListener('hashchange', () => {
  const id = trackedJob();
  if (id !== currentId) { currentId = id; render(pageState); }
});
$('submit-form').onsubmit = async event => {
  event.preventDefault(); const url = $('video-url').value.trim(), feedback = $('form-feedback');
  $('submit-button').disabled = true; feedback.className = 'feedback'; feedback.textContent = '正在保存提交…';
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15000);
  try {
    if (!request || request.url !== url) request = { requestId: requestId(), url };
    const response = await fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal }); const data = await response.json();
    if (!response.ok) throw new Error(errors[data.error] ?? '暂时无法提交，请稍后重试。');
    currentId = data.job.id; request = null;
    window.history.replaceState(window.history.state, '', `#job-${currentId}`);
    if (!pageState.jobs.some(job => job.id === currentId)) unobservedJobs.set(currentId, data.job);
    render(pageState);
  } catch (error) {
    feedback.className = 'feedback error';
    feedback.textContent = controller.signal.aborted || error instanceof TypeError
      ? '未收到提交回执。再次提交相同链接会沿用同一请求。' : error.message;
  } finally { clearTimeout(deadline); $('submit-button').disabled = false; }
};
connect();
