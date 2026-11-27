/** Run the shipped submit handler with a small DOM/SSE boundary; no browser or network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8')
  .replace(/^import \{ readArchiveBlob, readPngBlob \} from '\.\/download\.mjs';\r?\n/, '');
const job = {
  id: '364edaae-372f-4664-9e1c-eb958578b79b', bvid: 'BV1xx411c7mD',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
  state: 'queued', phase: 'queued', manifest: null,
};

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  children = [];
  dataset = {};
  attributes = new Map();
  listeners = new Map();
  value = '';
  disabled = false;
  hidden = false;
  isConnected = true;
  className = '';
  ownText = '';
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.children = children; }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) {
    this.attributes.delete(key);
    if (key === 'src') this.src = '';
  }
  classList = {
    add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
    remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
  };
  style = { setProperty() {} };
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  scrollIntoView(options) { this.scrolled = options ?? true; }
  getBoundingClientRect() { return { width: 240, height: 180, top: 100, left: 80 }; }
  focus() { this.focused = true; }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function matches(node, selector) {
  const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
  const cls = selector.match(/\.([a-z-]+)/)?.[1];
  const attribute = selector.match(/\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/);
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (cls && !node.className.split(/\s+/).includes(cls)) return false;
  if (attribute) {
    const actual = attribute[1].startsWith('data-')
      ? node.dataset[attribute[1].slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())]
      : node.getAttribute(attribute[1]) ?? node[attribute[1]];
    if (actual === undefined || actual === null || (attribute[2] !== undefined && actual !== attribute[2])) return false;
  }
  return true;
}

function setup({ crypto, fetchImpl, hash = '', IntersectionObserver, decodePreview } = {}) {
  const elements = new Map();
  const element = id => {
    const dynamic = [...elements.values()].flatMap(root => descendants(root)).find(node => node.id === id);
    if (dynamic) return dynamic;
    if (!elements.has(id)) { const node = new Element(); node.id = id; elements.set(id, node); }
    return elements.get(id);
  };
  const streams = [], requests = [];
  const reader = element('card-reader');
  reader.append(Object.assign(new Element(), { className: 'reader-scroll' }));
  reader.showModal = () => { reader.open = true; };
  reader.close = () => { reader.open = false; reader.listeners.get('close')(); };
  element('reader-image').decode = async () => {};
  if (decodePreview) element('hero-work-image').decode = decodePreview;
  class EventSource {
    listeners = new Map();
    closed = false;
    constructor() { streams.push(this); }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    close() { this.closed = true; }
    state(value) { this.listeners.get('state')({ data: JSON.stringify(value) }); }
  }
  const windowEvents = new Map();
  const location = { hash, pathname: '/', search: '', href: 'https://cards.example/' + hash };
  const writeHash = (_state, _unused, value) => { location.hash = new URL(value, 'https://cards.example/').hash; };
  const history = { replaceState: writeHash, pushState: writeHash };
  const window = { location, history, addEventListener(name, fn) { windowEvents.set(name, fn); } };
  const context = vm.createContext({
    document: {
      getElementById: element,
      createElement: tag => Object.assign(new Element(tag), tag === 'img' && decodePreview ? { decode: decodePreview } : {}),
      createElementNS: (_namespace, tag) => new Element(tag),
    },
    window, location, history, innerWidth: 1200, innerHeight: 800, IntersectionObserver,
    crypto: crypto ?? { randomUUID: () => job.id },
    EventSource, AbortController, URL, setTimeout, clearTimeout,
    fetch: async (...args) => {
      requests.push({ url: args[0], body: JSON.parse(args[1].body), signal: args[1].signal });
      return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ job }) };
    },
  });
  vm.runInContext(source, context, { filename: 'public/app.js' });
  element('video-url').value = job.bvid;
  return { element, requests, location, windowEvents, stream: streams[0], submit: () => element('submit-form').onsubmit({ preventDefault() {} }) };
}

test('POST acknowledgement immediately adds the selected job while SSE is disconnected', async () => {
  let acknowledge;
  const ui = setup({ fetchImpl: () => new Promise(resolve => { acknowledge = resolve; }) });
  ui.stream.state({ connection: 'connected', jobs: [] });
  ui.stream.onerror();
  const submitted = ui.submit();
  assert.equal(ui.element('submit-button').disabled, true);
  assert.match(ui.element('form-feedback').textContent, /正在保存/);
  acknowledge({ ok: true, json: async () => ({ job }) });
  await submitted;
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.element('queue-count').textContent, '1');
  assert.match(ui.element('queue').textContent, /BV1xx411c7mD/);
  assert.match(ui.element('queue').children[0].className, /selected/);
  assert.match(ui.element('form-feedback').textContent, /BV1xx411c7mD.*排队/);
  assert.match(ui.element('connection-label').textContent, /已断开/);
  assert.equal(ui.element('reconnect').hidden, false);
  assert.equal(ui.element('submit-button').disabled, false);
});

test('a later source failure event updates the feedback next to the submit button', async () => {
  const ui = setup();
  await ui.submit();
  ui.stream.state({ connection: 'connected', jobs: [{ ...job, state: 'failed', phase: 'source', error: 'creation-failed' }] });
  assert.equal(ui.element('form-feedback').textContent, 'BV1xx411c7mD · 读取原视频失败');
  assert.match(ui.element('form-feedback').className, /error/);
  assert.match(ui.element('queue').textContent, /读取原视频失败/);
  assert.equal(ui.element('submit-button').disabled, false);
  assert.equal(ui.requests.length, 1);
});

test('a WebView without randomUUID submits once using a cryptographic UUID fallback', async () => {
  let randomCalls = 0;
  const ui = setup({ crypto: { getRandomValues(bytes) { randomCalls++; bytes.fill(171); return bytes; } } });
  await ui.submit();
  assert.equal(randomCalls, 1);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].url, '/api/jobs');
  assert.match(ui.requests[0].body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(ui.requests[0].body.url, job.bvid);
  assert.match(ui.element('form-feedback').textContent, /排队/);
  assert.equal(ui.element('submit-button').disabled, false);
});


test('an old empty SSE snapshot cannot revoke a just-acknowledged active job', async () => {
  const ui = setup();
  await ui.submit();
  ui.stream.state({ connection: 'connected', jobs: [] });
  assert.equal(ui.element('queue-count').textContent, '1');
  const row = ui.element('queue').querySelector('[data-job-id="' + job.id + '"]');
  assert.ok(row, 'acknowledged job remains visible after the delayed initial snapshot');
  assert.match(row.className, /selected/);
  assert.match(ui.element('form-feedback').textContent, /排队/);
  assert.equal(ui.requests.length, 1, 'retaining a receipt never resubmits it');
});

test('same-video active work stays selected while the older completed job belongs to history', async () => {
  const ui = setup();
  const older = { ...job, id: '4574df4d-5521-41eb-a678-159a6f327312', state: 'completed', phase: 'complete',
    manifest: { title: 'Older cards', author: 'Author', cards: [] } };
  ui.stream.state({ connection: 'connected', jobs: [older] });
  await ui.submit();
  const running = { ...job, state: 'processing', phase: 'transcript' };
  ui.stream.state({ connection: 'connected', jobs: [running, older] });
  assert.equal(ui.location.hash, '#job-' + job.id);
  assert.equal(ui.element('queue-count').textContent, '1');
  const selected = ui.element('queue').querySelector('[data-job-id="' + job.id + '"]');
  assert.ok(selected);
  assert.match(selected.className, /selected/);
  assert.equal(ui.element('queue').querySelector('[data-job-id="' + older.id + '"]'), null);
  assert.ok(ui.element('history-list').querySelector('a[href="#result-' + older.id + '"]'));
  assert.match(ui.element('history-label').textContent, /1/);
  assert.match(ui.element('form-feedback').textContent, /识别原话/);
  const steps = selected.querySelector('ol.job-steps');
  assert.ok(steps, 'active job exposes its production stages');
  const currentSteps = steps.querySelectorAll('[aria-current="step"]');
  assert.equal(currentSteps.length, 1);
  assert.match(currentSteps[0].textContent, /整理原话/);
  const completed = { ...job, state: 'completed', phase: 'complete', manifest: { title: 'Current cards', author: 'Author', cards: [] } };
  ui.stream.state({ connection: 'connected', jobs: [completed, older] });
  assert.equal(ui.element('queue-count').textContent, '0');
  const retained = ui.element('queue').querySelector('[data-job-id="' + job.id + '"]');
  assert.ok(retained, 'current terminal job remains in the task panel');
  assert.match(retained.className, /selected/);
  assert.ok(ui.element('history-list').querySelector('a[href="#result-' + older.id + '"]'));
  assert.equal(ui.element('history-list').querySelector('a[href="#result-' + job.id + '"]'), null);
  assert.ok(ui.element('gallery').children.find(node => node.id === 'result-' + job.id));
  assert.ok(retained.querySelector('a[href="#result-' + job.id + '"]'), 'current work links to its own result, not older cards for the same BV');
  assert.equal(ui.requests.length, 1);
});

test('a tracked job hash restores the exact same-video run without resubmitting', () => {
  const ui = setup({ hash: '#job-' + job.id });
  const older = { ...job, id: '4574df4d-5521-41eb-a678-159a6f327312', state: 'completed', phase: 'complete',
    manifest: { title: 'Older cards', author: 'Author', cards: [] } };
  ui.stream.state({ connection: 'connected', jobs: [job, older] });
  assert.match(ui.element('queue').querySelector('[data-job-id="' + job.id + '"]').className, /selected/);
  assert.equal(ui.element('queue-count').textContent, '1');
  assert.equal(ui.requests.length, 0);
  ui.location.hash = '#result-' + older.id;
  ui.windowEvents.get('hashchange')();
  assert.equal(ui.element('gallery').children[0].id, 'result-' + older.id);
  assert.match(ui.element('queue').querySelector('[data-job-id="' + job.id + '"]').className, /selected/);
  assert.equal(ui.element('queue').querySelector('[data-job-id="' + older.id + '"]'), null);
  assert.equal(ui.element('queue-count').textContent, '1', 'selecting old output does not hide active production');
  assert.equal(ui.requests.length, 0, 'changing the tracked result never creates another job');
});

test('three result images render as individually numbered PNG cards', () => {
  const ui = setup({ hash: '#result-' + job.id });
  const files = ['card-001.png', 'card-002.png', 'card-003.png'];
  const cards = files.map((file, index) => ({ file, quote: `Quote ${index + 1}`, start: index * 10, end: index * 10 + 5 }));
  const result = { ...job, state: 'completed', manifest: { title: 'Result cards', author: 'Author', cards } };
  ui.stream.state({ connection: 'connected', jobs: [result] });

  const figures = ui.element('gallery').querySelectorAll('figure.card');
  assert.equal(figures.length, 3);
  for (const [index, figure] of figures.entries()) {
    const url = `/api/jobs/${job.id}/${files[index]}`;
    const original = `/api/jobs/${job.id}/original/${files[index]}`;
    assert.equal(figure.querySelector('.card-index').textContent, `第 ${index + 1} 张`);
    const preview = figure.querySelector('.card-preview');
    assert.equal(preview.querySelector('img').src, url);
    assert.equal(preview.href, original);
    assert.equal(preview.target, '_blank');
    assert.equal(preview.getAttribute('aria-label'), `查看第 ${index + 1} 张原图`);
    assert.deepEqual(figure.querySelectorAll('a').filter(link => !link.download && link.href.endsWith(files[index])), [preview]);
    const download = figure.querySelector('.card-download');
    assert.equal(download.href, original);
    assert.equal(download.download, `${job.bvid}-${files[index]}`);
    assert.equal(download.textContent, '');
    assert.equal(download.getAttribute('aria-label'), `下载第 ${index + 1} 张 PNG`);
    assert.equal(download.querySelector('svg').getAttribute('aria-hidden'), 'true');
  }
});

test('same-run result navigation moves focus to the exact title and keeps the tracked run across section links', () => {
  const ui = setup({ hash: '#job-' + job.id });
  const completed = { ...job, state: 'completed', phase: 'complete',
    manifest: { title: 'Current result', author: 'Author', cards: [] } };
  ui.stream.state({ connection: 'connected', jobs: [completed] });
  ui.location.hash = '#result-' + job.id;
  ui.windowEvents.get('hashchange')();
  const result = ui.element('result-' + job.id);
  assert.equal(result.querySelector('h3').focused, true);
  assert.equal(result.scrolled.behavior, 'smooth');
  ui.location.hash = '#works';
  ui.windowEvents.get('hashchange')();
  ui.stream.state({ connection: 'connected', jobs: [completed] });
  assert.equal(ui.element('queue').children[0].dataset.jobId, job.id);
});

test('the work index selects one exact submission while the active production job keeps its place', () => {
  const ui = setup({ hash: '#job-' + job.id });
  const completed = id => ({ ...job, id, createdAt: Date.now(), state: 'completed', phase: 'complete',
    manifest: { title: 'Same video', author: 'Author', cards: [{ file: 'card-001.png', quote: 'Original quote', start: 4, end: 8 }] } });
  const newer = completed('4574df4d-5521-41eb-a678-159a6f327312');
  const older = completed('4764c426-e995-4486-a319-cab1dbc7a357');
  const snapshot = { connection: 'connected', jobs: [job, newer, older] };
  const gallery = ui.element('gallery'), archive = ui.element('work-index');
  ui.stream.state(snapshot);
  assert.equal(gallery.children.length, 1);
  assert.equal(gallery.children[0].id, 'result-' + newer.id);
  const choice = archive.querySelector(`[data-job-id="${older.id}"]`);
  assert.equal(choice.href, '#result-' + older.id);
  choice.onclick({ button: 0, preventDefault() {} });
  const shown = gallery.children[0];
  assert.equal(shown.id, 'result-' + older.id);
  assert.match(shown.querySelector('.card-preview').href, new RegExp(older.id));
  assert.equal(choice.getAttribute('aria-current'), 'true');
  assert.equal(ui.location.hash, '#result-' + older.id);
  assert.equal(ui.element('queue').querySelector('.job-row').dataset.jobId, job.id);

  ui.stream.state({ ...snapshot, jobs: [completed('bca6c7b4-d21f-4039-ab22-f660f150ea4b'), ...snapshot.jobs] });
  assert.equal(gallery.children[0], shown, 'a new completion keeps the chosen gallery and opener intact');
  ui.location.hash = '#result-' + newer.id;
  ui.windowEvents.get('hashchange')();
  assert.equal(gallery.children[0].id, 'result-' + newer.id);
  assert.equal(gallery.children[0].querySelector('h3').focused, true);
  assert.equal(ui.element('queue').querySelector('.job-row').dataset.jobId, job.id);
  gallery.children[0].querySelector('.card-preview').onclick({ button: 0, preventDefault() {} });
  ui.location.hash = '#result-' + older.id;
  ui.windowEvents.get('hashchange')();
  assert.equal(ui.element('card-reader').open, false);
  assert.equal(gallery.children[0].querySelector('h3').focused, true, 'navigating from a reader focuses the new result');
});

test('original reader switches exact frames, ignores an obsolete image failure and restores focus after a gallery update', async () => {
  const ui = setup();
  const cards = [1, 2].map(number => ({ file: `card-00${number}.png`, quote: `Quote ${number}`, start: 0, end: 5 }));
  const completed = { ...job, state: 'completed', manifest: { title: 'Result cards', author: 'Author', cards } };
  ui.stream.state({ connection: 'connected', jobs: [completed] });
  const reader = ui.element('card-reader'), image = ui.element('reader-image');
  const pending = [];
  image.decode = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const firstPreview = ui.element('gallery').querySelector('.card-preview');
  let defaultPrevented = false;
  const click = { button: 0, preventDefault() { defaultPrevented = true; } };
  firstPreview.onclick({ ...click, metaKey: true });
  assert.equal(defaultPrevented, false);
  assert.notEqual(reader.open, true);
  firstPreview.onclick(click);
  assert.equal(defaultPrevented, true);
  assert.equal(reader.open, true);
  assert.equal(ui.element('reader-position').textContent, '1 / 2');
  assert.equal(ui.element('reader-prev').disabled, true);
  ui.element('reader-next').onclick();
  assert.equal(ui.element('reader-position').textContent, '2 / 2');
  assert.equal(ui.element('reader-next').disabled, true);
  assert.match(image.src, /\/original\/card-002\.png$/);
  assert.equal(ui.element('reader-save').download, `${job.bvid}-card-002.png`);
  pending[1].resolve();
  pending[0].reject(new Error('An obsolete read failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(image.hidden, false);
  assert.equal(ui.element('reader-open').hidden, true);
  assert.equal(ui.element('hero-work-link').href, '#result-' + job.id);
  assert.match(ui.element('hero-work-image').src, /\/card-001\.png$/);

  firstPreview.isConnected = false;
  ui.stream.state({ connection: 'connected', jobs: [{ ...completed, manifest: { ...completed.manifest, title: 'Updated gallery' } }] });
  assert.equal(ui.element('reader-position').textContent, '2 / 2');
  reader.listeners.get('cancel')({ preventDefault() {} });
  assert.equal(reader.open, false);
  assert.equal(ui.element('gallery').querySelector('.card-preview').focused, true);
});

test('visible previews wait for a decode slot without blocking direct original links', async () => {
  const observed = new Set(), pending = [];
  let onIntersection;
  class IntersectionObserver {
    constructor(listener) { onIntersection = listener; }
    observe(image) { observed.add(image); }
    unobserve(image) { observed.delete(image); }
  }
  const ui = setup({ IntersectionObserver, decodePreview: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const cards = [1, 2, 3, 4].map(number => ({ file: `card-00${number}.png`, quote: `Quote ${number}`, start: 0, end: 5 }));
  ui.stream.state({ connection: 'connected', jobs: [{ ...job, state: 'completed', manifest: { title: 'Result cards', author: 'Author', cards } }] });
  assert.equal(observed.size, 5, 'a hero and four thumbnails are observed');
  const previews = ui.element('gallery').querySelectorAll('.card-preview');
  assert.match(previews[3].href, /\/original\/card-004\.png$/);
  assert.equal(previews[3].querySelector('img').src, undefined);
  onIntersection([...observed].map(target => ({ target, isIntersecting: true })));
  assert.equal(pending.length, 3);
  const lastImage = previews[3].querySelector('img');
  assert.equal(lastImage.src, undefined);
  onIntersection([{ target: lastImage, isIntersecting: false }]);
  pending[0].reject(new Error('first image failed'));
  pending[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 4);
  assert.equal(lastImage.src, undefined);
  onIntersection([{ target: lastImage, isIntersecting: true }]);
  assert.equal(pending.length, 5);
  assert.match(lastImage.src, /\/card-004\.png$/);
});
