import { readArchiveBlob, readPngBlob } from './download.mjs';
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
let stream, request = null;
let archiveFingerprint = '[]', galleryFingerprint = 'null';
let currentId = trackedJob();
let selectedWorkId = window.location.hash.startsWith('#result-') ? currentId : undefined;
let initialAnchor = currentId ? window.location.hash.slice(1) : '';
const unobservedJobs = new Map();
const jobPhases = new Map();
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let pageState = { connection: 'disconnected', jobs: [] };
let downloadingBundle = false;
const downloadControllers = new Set();
const downloadURLs = new Map();
const cardDownloads = new WeakMap();
const previewSources = new WeakMap();
const visiblePreviews = new Map();
const MAX_PREVIEWS_LOADING = 3;
let previewsLoading = 0;
const previewObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (!previewSources.has(target)) continue;
    if (isIntersecting) visiblePreviews.set(target, previewSources.get(target));
    else visiblePreviews.delete(target);
  }
  loadVisiblePreviews();
}) : null;
function loadVisiblePreviews() {
  for (const [image, source] of visiblePreviews) {
    if (previewsLoading >= MAX_PREVIEWS_LOADING) break;
    visiblePreviews.delete(image);
    if (!image.isConnected || previewSources.get(image) !== source) continue;
    previewObserver.unobserve(image);
    previewSources.delete(image);
    previewsLoading++;
    image.src = source;
    // The next previews start only when a visible image finishes decoding or fails.
    void image.decode().catch(() => {}).finally(() => {
      previewsLoading--;
      loadVisiblePreviews();
    });
  }
}
function setPreviewSource(image, source) {
  if (!previewObserver || typeof image.decode !== 'function') {
    image.loading = 'lazy';
    image.src = source;
    return;
  }
  previewSources.set(image, source);
  previewObserver.observe(image);
}
function clearPreviewSource(image) {
  previewObserver?.unobserve(image);
  previewSources.delete(image);
  visiblePreviews.delete(image);
  image.removeAttribute('src');
}
window.addEventListener('pagehide', () => {
  for (const controller of downloadControllers) controller.abort();
  for (const [url, timer] of downloadURLs) { clearTimeout(timer); URL.revokeObjectURL(url); }
  downloadURLs.clear();
});
async function saveDownload(read, source, filename, timeout) {
  const controller = new AbortController();
  downloadControllers.add(controller);
  const deadline = setTimeout(() => controller.abort(), timeout);
  try {
    const blob = await read(source, { signal: controller.signal });
    if (controller.signal.aborted) throw new Error('下载已中断。');
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.hidden = true;
    // One-shot resource cleanup, never a status query or reconnect loop.
    const timer = setTimeout(() => { URL.revokeObjectURL(url); downloadURLs.delete(url); }, 30000);
    downloadURLs.set(url, timer);
    document.body.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  } finally {
    clearTimeout(deadline);
    downloadControllers.delete(controller);
  }
}
async function downloadBundle(job, button, feedback) {
  if (downloadingBundle) { feedback.textContent = '另一组下载正在准备，请稍等。'; return; }
  downloadingBundle = true; button.disabled = true; feedback.className = 'download-feedback'; feedback.textContent = '正在读取完整压缩包…';
  try {
    await saveDownload(readArchiveBlob, `/api/jobs/${job.id}/cards.zip`, `${job.bvid}-cards.zip`, 120000);
    feedback.textContent = '已交给浏览器保存，请查看下载记录。';
  } catch { feedback.className = 'download-feedback error'; feedback.textContent = '下载未完成，请重新点击。'; }
  finally { downloadingBundle = false; button.disabled = false; }
}
async function downloadCard(event, link, feedback) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (cardDownloads.has(link)) return;
  const ticket = {};
  cardDownloads.set(link, ticket);
  link.setAttribute('aria-disabled', 'true');
  feedback.classList.remove('error');
  feedback.textContent = '正在读取完整图片…';
  try {
    await saveDownload(readPngBlob, link.href, link.download, 60000);
    if (cardDownloads.get(link) === ticket) feedback.textContent = '已交给浏览器保存，请查看下载记录。';
  } catch {
    if (cardDownloads.get(link) === ticket) {
      feedback.classList.add('error');
      feedback.textContent = '图片下载未完成，请重新点击。';
    }
  } finally {
    if (cardDownloads.get(link) === ticket) {
      cardDownloads.delete(link);
      link.removeAttribute('aria-disabled');
    }
  }
}
function el(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function link(text, href, className) { const a = el('a', className, text); a.href = href; return a; }
function saveIcon() {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM7 3v6h10V3M7 21v-7h10v7');
  svg.append(path);
  return svg;
}
const originalURL = (job, card) => `/api/jobs/${job.id}/original/${card.file}`;
function configureDownload(action, job, card, number) {
  action.href = originalURL(job, card);
  action.download = `${job.bvid}-${card.file}`;
  action.setAttribute('aria-label', `下载第 ${number} 张 PNG`);
  action.title = '下载 PNG';
}

const reader = $('card-reader');
const readerImage = $('reader-image');
const readerSave = $('reader-save');
const readerFeedback = $('reader-feedback');
const readerLoading = $('reader-loading');
const readerOpen = $('reader-open');
const readerClose = $('reader-close');
const readerPrev = $('reader-prev');
const readerNext = $('reader-next');
let reading;
readerSave.textContent = '';
readerSave.append(saveIcon());
readerSave.onclick = event => void downloadCard(event, readerSave, readerFeedback);
async function showCard(index, switching = false) {
  if (!reading || reading.closing || !reading.job.manifest.cards[index]) return;
  const { job } = reading;
  const card = job.manifest.cards[index];
  const count = job.manifest.cards.length;
  const frame = {};
  reading.index = index;
  reading.frame = frame;
  $('reader-title').textContent = job.manifest.title;
  $('reader-position').textContent = `${index + 1} / ${count}`;
  readerPrev.disabled = index === 0;
  readerNext.disabled = index === count - 1;
  if (readerPrev.disabled && document.activeElement === readerPrev) readerNext.focus();
  if (readerNext.disabled && document.activeElement === readerNext) readerPrev.focus();
  cardDownloads.delete(readerSave);
  readerSave.removeAttribute('aria-disabled');
  configureDownload(readerSave, job, card, index + 1);
  readerFeedback.textContent = '';
  readerFeedback.classList.remove('error');
  readerOpen.href = originalURL(job, card);
  readerOpen.hidden = true;
  readerLoading.textContent = '正在加载原图…';
  readerLoading.hidden = false;
  readerImage.hidden = true;
  readerImage.alt = card.quote;
  readerImage.src = readerOpen.href;
  reader.querySelector('.reader-scroll').scrollTop = 0;
  reader.classList.remove('reader-switch');
  try {
    await readerImage.decode();
    if (reading?.frame !== frame || reading.closing) return;
    readerImage.hidden = false;
    readerLoading.hidden = true;
    if (switching && !reducedMotion()) reader.classList.add('reader-switch');
  } catch {
    if (reading?.frame !== frame || reading.closing) return;
    readerLoading.textContent = '原图未能加载。';
    readerOpen.hidden = false;
  }
}
function openReader(event, trigger, job, index) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
      typeof reader.showModal !== 'function' || reading) return;
  const bounds = trigger.getBoundingClientRect();
  reader.style.setProperty('--reader-origin-x', `${(bounds.left + bounds.width / 2) / innerWidth * 100}%`);
  reader.style.setProperty('--reader-origin-y', `${(bounds.top + bounds.height / 2) / innerHeight * 100}%`);
  event.preventDefault();
  reading = { job, trigger, openedIndex: index, index, closing: false };
  reader.classList.add('reader-enter');
  reader.showModal();
  void showCard(index);
  readerClose.focus();
}
function closeReader() {
  if (!reading || reading.closing) return;
  const session = reading;
  session.closing = true;
  reader.classList.remove('reader-enter', 'reader-switch');
  reader.classList.add('reader-exit');
  const animation = reader.getAnimations?.({ subtree: true }).find(item => item.animationName === 'reader-out');
  const finish = () => { if (reading === session && reader.open) reader.close(); };
  if (animation && !reducedMotion()) void animation.finished.then(finish, finish);
  else finish();
}
readerClose.onclick = closeReader;
const changeReaderCard = offset => reading && void showCard(reading.index + offset, true);
readerPrev.onclick = () => changeReaderCard(-1);
readerNext.onclick = () => changeReaderCard(1);
reader.addEventListener('keydown', event => {
  if (!reading || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    changeReaderCard(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
reader.addEventListener('cancel', event => { event.preventDefault(); closeReader(); });
let backdropDown;
reader.addEventListener('pointerdown', event => {
  backdropDown = event.isPrimary && event.button === 0 && event.target === reader;
});
reader.addEventListener('pointerup', event => {
  if (event.target !== reader) backdropDown = false;
});
reader.addEventListener('pointercancel', () => { backdropDown = false; });
reader.addEventListener('click', event => {
  if (backdropDown && event.target === reader) closeReader();
  backdropDown = false;
});
reader.addEventListener('close', () => {
  if (!reading) return;
  const { job, openedIndex, trigger, navigation } = reading;
  reading = undefined;
  backdropDown = false;
  reader.classList.remove('reader-enter', 'reader-exit', 'reader-switch');
  readerImage.removeAttribute('src');
  if (navigation) {
    if (navigation.resultId) highlightWork(navigation.resultId, true);
    return;
  }
  const result = $(`result-${job.id}`);
  const focus = trigger.isConnected ? trigger
    : result?.querySelectorAll('.card-preview')[openedIndex] ?? result?.querySelector('h3')
      ?? $('work-index').querySelector(`[data-job-id="${job.id}"]`);
  if (!trigger.isConnected) focus?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  focus?.focus({ preventScroll: true });
});

const inputGlow = $('video-url').parentElement;
inputGlow?.addEventListener('pointermove', event => {
  if (event.pointerType !== 'mouse' || reducedMotion()) return;
  const bounds = inputGlow.getBoundingClientRect();
  inputGlow.style.setProperty('--glow-x', `${(event.clientX - bounds.left) / bounds.width * 100}%`);
  inputGlow.style.setProperty('--glow-y', `${(event.clientY - bounds.top) / bounds.height * 100}%`);
});
inputGlow?.addEventListener('pointerleave', () => {
  inputGlow.style.removeProperty('--glow-x');
  inputGlow.style.removeProperty('--glow-y');
});
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
  const phase = `${job.state}:${job.phase}`;
  if (jobPhases.has(job.id) && jobPhases.get(job.id) !== phase) row.classList.add('job-phase-change');
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
  $('connection-label').dataset.state = state.connection;
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
  jobPhases.clear();
  for (const job of jobs) jobPhases.set(job.id, `${job.state}:${job.phase}`);
  renderHistory(jobs.filter(job => terminal(job) && job.id !== currentId), titles);
  renderGallery(finished);
  const anchor = initialAnchor && $(initialAnchor);
  if (anchor) { initialAnchor = ''; anchor.scrollIntoView(); }
}
let featuredSource;
function renderFeatured(finished) {
  const job = finished.find(item => item.manifest.cards.length);
  const figure = $('hero-work'), image = $('hero-work-image'), action = $('hero-work-link');
  if (!job) {
    figure.hidden = true;
    featuredSource = undefined;
    clearPreviewSource(image);
    return;
  }
  const source = `/api/jobs/${job.id}/${job.manifest.cards[0].file}`;
  $('hero-work-title').textContent = job.manifest.title;
  $('hero-work-credit').textContent = job.manifest.author;
  action.href = `#result-${job.id}`;
  action.setAttribute('aria-label', `查看《${job.manifest.title}》的成品`);
  if (featuredSource === source) return;
  if (featuredSource) clearPreviewSource(image);
  featuredSource = source;
  figure.hidden = false;
  image.onerror = () => {
    if (featuredSource === source && image.getAttribute('src') === source) figure.hidden = true;
  };
  setPreviewSource(image, source);
}
function renderWorkIndex(finished) {
  const fingerprint = JSON.stringify(finished);
  if (fingerprint === archiveFingerprint) return;
  archiveFingerprint = fingerprint;
  renderFeatured(finished);
  const archive = $('work-index');
  const focusId = document.activeElement?.classList.contains('work-choice') ? document.activeElement.dataset.jobId : undefined;
  if (previewObserver) archive.querySelectorAll('.work-thumb').forEach(clearPreviewSource);
  archive.replaceChildren();
  archive.hidden = finished.length < 2;
  if (archive.hidden) return;
  for (const job of finished) {
    const href = `#result-${job.id}`;
    const choice = link('', href, 'work-choice');
    choice.dataset.jobId = job.id;
    const cover = job.manifest.cards[0];
    if (cover) {
      const photo = el('img', 'work-thumb');
      photo.alt = '';
      photo.decoding = 'async';
      choice.append(photo);
      setPreviewSource(photo, `/api/jobs/${job.id}/${cover.file}`);
    }
    const info = el('span', 'work-choice-info');
    info.append(el('span', 'work-choice-title', job.manifest.title), el('span', 'work-choice-date', submittedAt(job) || job.bvid));
    choice.append(info);
    choice.onclick = event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (href === window.location.hash && selectedWorkId === job.id) return;
      selectedWorkId = job.id;
      if (href !== window.location.hash) window.history.pushState(window.history.state, '', href);
      render(pageState);
      highlightWork(job.id);
    };
    archive.append(choice);
    if (job.id === focusId) choice.focus({ preventScroll: true });
  }
}
function highlightWork(id, move = false) {
  const result = $(`result-${id}`);
  if (!result) return;
  const reduced = reducedMotion();
  if (!reduced) result.classList.add('result-arrival');
  if (move) {
    result.querySelector('h3')?.focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start', behavior: reduced ? 'instant' : 'smooth' });
  }
}
function renderGallery(finished) {
  renderWorkIndex(finished);
  const readerJobId = reading && !reading.navigation ? reading.job.id : undefined;
  const job = finished.find(item => item.id === (selectedWorkId ?? readerJobId ?? currentId)) ?? finished[0];
  for (const choice of $('work-index').children) {
    if (choice.dataset.jobId === job?.id) choice.setAttribute('aria-current', 'true');
    else choice.removeAttribute('aria-current');
  }
  const fingerprint = JSON.stringify(job ?? null);
  if (fingerprint === galleryFingerprint) return;
  galleryFingerprint = fingerprint;
  const gallery = $('gallery');
  if (previewObserver) gallery.querySelectorAll('.card-preview img').forEach(clearPreviewSource);
  gallery.replaceChildren();
  if (!job) {
    gallery.append(el('p', 'empty', '卡片制作完成后会显示在这里。'));
    return;
  }
  gallery.append(renderWork(job));
}
function renderWork(job) {
  const group = el('section', 'result'), heading = el('div', 'result-heading'), title = el('div');
  group.id = `result-${job.id}`;
  const resultTitle = el('h3', '', job.manifest.title);
  resultTitle.tabIndex = -1;
  title.append(resultTitle);
  group.addEventListener('animationend', event => {
    if (event.target === group) group.classList.remove('result-arrival');
  });
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
    const original = originalURL(job, card);
    const figure = el('figure', 'card');
    const cardHeading = el('div', 'card-heading');
    const sourceTime = link(`${time(card.start)}–${time(card.end)}`, `${job.url}?t=${Math.floor(card.start)}`, 'card-time'); sourceTime.target = '_blank'; sourceTime.rel = 'noopener noreferrer';
    const download = link('', original, 'card-download');
    configureDownload(download, job, card, number);
    download.append(saveIcon());
    const cardFeedback = el('p', 'download-feedback');
    cardFeedback.setAttribute('role', 'status');
    download.onclick = event => void downloadCard(event, download, cardFeedback);
    cardHeading.append(el('strong', 'card-index', `第 ${number} 张`), sourceTime, download);

    const preview = link('', original, 'card-preview');
    preview.target = '_blank'; preview.rel = 'noopener';
    preview.setAttribute('aria-label', `查看第 ${number} 张原图`);
    preview.onclick = event => openReader(event, preview, job, index);
    const img = el('img');
    img.alt = ''; img.decoding = 'async';
    preview.append(img);
    setPreviewSource(img, url);

    const caption = el('figcaption');
    caption.append(el('p', 'card-quote', card.quote), cardFeedback);
    figure.append(preview, cardHeading, caption);
    cards.append(figure);
  }
  group.append(cards);
  return group;
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
  if (`#${initialAnchor}` !== window.location.hash) initialAnchor = '';
  const id = trackedJob();
  if (!id) return;
  const result = window.location.hash.startsWith('#result-');
  selectedWorkId = result ? id : undefined;
  if (!result || !currentId) currentId = id;
  const changedWhileReading = reading && reading.job.id !== id;
  if (changedWhileReading) reading.navigation = { resultId: result ? id : undefined };
  render(pageState);
  if (changedWhileReading) closeReader();
  else if (result && !reading) highlightWork(id, true);
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
    currentId = data.job.id; selectedWorkId = undefined; request = null;
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
