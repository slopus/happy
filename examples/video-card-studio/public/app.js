import { readArchiveBlob } from './download.mjs';
const $ = id => document.getElementById(id);
const statuses = { queued: '排队等待制作', dispatching: '正在提交制作', waiting: '等待制作机器接收', processing: '正在制作', completed: '制作完成', failed: '本次制作未完成', uncertain: '执行中断，等待管理员核对' };
const phases = { source: '读取原视频', transcript: '识别原话', proofread: '对照画面核对字幕', plan: '精选完整观点', frames: '提取原画面', selection: '挑选清晰画面', cards: '排版长图', archive: '保存图片', upload: '上传成品' };
const errors = { 'invalid-video': '请输入公开单 P 的 B 站视频链接或完整 BV 号。', 'queue-full': '制作队列已满，请稍后再提交。', 'rate-limit': '提交得有些快，请稍后再试。', 'idempotency-conflict': '这次提交的链接已变化，请重新提交。' };
let stream, currentId, request = null, galleryFingerprint;
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
function render(state) {
  pageState = state;
  $('connection-label').textContent = state.connection === 'closed' ? '页面连接已断开，制作记录仍会保留'
    : state.connection === 'connected' ? '制作通道已连接' : '制作通道暂未连接，提交会保留';
  const current = state.jobs.find(job => job.id === currentId);
  if (current && !request) {
    const feedback = $('form-feedback');
    feedback.className = ['failed', 'uncertain'].includes(current.state) ? 'feedback error' : 'feedback';
    feedback.textContent = `${current.bvid} · ${jobStatus(current)}`;
  }
  $('queue-count').textContent = state.jobs.length;
  const queue = $('queue'); queue.replaceChildren();
  if (!state.jobs.length) queue.append(el('p', 'muted', '还没有提交记录'));
  for (const job of state.jobs) {
    const row = el('div', 'job-row' + (job.id === currentId ? ' selected' : ''));
    row.append(el('p', 'job-title', job.manifest?.title ?? job.bvid));
    const source = link('查看原视频', job.url, 'job-source'); source.target = '_blank'; source.rel = 'noopener noreferrer'; row.append(source);
    row.append(el('p', 'job-state' + (['failed', 'uncertain'].includes(job.state) ? ' error' : ''), jobStatus(job))); queue.append(row);
  }
  const finished = state.jobs.filter(job => job.state === 'completed' && job.manifest), fingerprint = JSON.stringify(finished);
  if (fingerprint === galleryFingerprint || !finished.length) return;
  galleryFingerprint = fingerprint; const gallery = $('gallery'); gallery.replaceChildren();
  for (const job of finished) {
    const group = el('section', 'result'), heading = el('div', 'result-heading'), title = el('div');
    title.append(el('h3', '', job.manifest.title));
    const source = link(`${job.manifest.author} · ${job.bvid} · 自动转写，待核对`, job.url, 'result-source'); source.target = '_blank'; source.rel = 'noopener noreferrer'; title.append(source);
    const downloadArea = el('div', 'download-area'), bundle = el('button', 'download-all', `整组下载 · ${job.manifest.cards.length} 张`), feedback = el('p', 'download-feedback');
    bundle.type = 'button'; bundle.dataset.jobId = job.id; feedback.setAttribute('role', 'status');
    bundle.onclick = () => void downloadBundle(job, bundle, feedback);
    downloadArea.append(bundle, feedback); heading.append(title, downloadArea); group.append(heading);
    const cards = el('div', 'cards');
    for (const card of job.manifest.cards) {
      const figure = el('figure', 'card'), url = `/api/jobs/${job.id}/${card.file}`, imageLink = link('', url), img = el('img');
      img.src = url; img.alt = card.quote; img.loading = 'lazy'; imageLink.target = '_blank'; imageLink.rel = 'noopener'; imageLink.append(img); figure.append(imageLink);
      const caption = el('figcaption'), actions = el('div', 'card-actions'); caption.append(el('p', 'card-quote', card.quote));
      const sourceTime = link(`${time(card.start)}–${time(card.end)}`, `${job.url}?t=${Math.floor(card.start)}`, 'card-time'); sourceTime.target = '_blank'; sourceTime.rel = 'noopener noreferrer';
      const download = link('保存长图', url, 'card-download'); download.download = `${job.bvid}-${card.file}`; actions.append(sourceTime, download); caption.append(actions); figure.append(caption); cards.append(figure);
    }
    group.append(cards); gallery.append(group);
  }
}
function connect() {
  stream?.close(); $('reconnect').hidden = true; stream = new EventSource('/api/events');
  stream.addEventListener('state', event => render(JSON.parse(event.data)));
  stream.onerror = () => { stream.close(); render({ ...pageState, connection: 'closed' }); $('reconnect').hidden = false; };
}
$('reconnect').onclick = connect;
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
    const jobs = pageState.jobs.some(job => job.id === currentId) ? pageState.jobs : [data.job, ...pageState.jobs];
    render({ ...pageState, jobs });
  } catch (error) {
    feedback.className = 'feedback error';
    feedback.textContent = controller.signal.aborted || error instanceof TypeError
      ? '未收到提交回执。再次提交相同链接会沿用同一请求。' : error.message;
  } finally { clearTimeout(deadline); $('submit-button').disabled = false; }
};
connect();
