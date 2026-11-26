/** Run the shipped submit handler with a small DOM/SSE boundary; no browser or network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8')
  .replace(/^import \{ readArchiveBlob \} from '\.\/download\.mjs';\r?\n/, '');
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
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  scrollIntoView() {}
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function matches(node, selector) {
  const tag = selector.match(/^[a-z]+/i)?.[0];
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

function setup({ crypto, fetchImpl, hash = '' } = {}) {
  const elements = new Map();
  const element = id => {
    const dynamic = [...elements.values()].flatMap(root => descendants(root)).find(node => node.id === id);
    if (dynamic) return dynamic;
    if (!elements.has(id)) { const node = new Element(); node.id = id; elements.set(id, node); }
    return elements.get(id);
  };
  const streams = [], requests = [];
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
  const history = { replaceState(_state, _unused, value) { location.hash = new URL(value, 'https://cards.example/').hash; } };
  const window = { location, history, addEventListener(name, fn) { windowEvents.set(name, fn); } };
  const context = vm.createContext({
    document: { getElementById: element, createElement: tag => new Element(tag) },
    window, location, history,
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
  assert.match(ui.element('queue').querySelector('[data-job-id="' + older.id + '"]').className, /selected/);
  assert.doesNotMatch(ui.element('queue').querySelector('[data-job-id="' + job.id + '"]').className, /selected/);
  assert.equal(ui.element('queue-count').textContent, '1', 'selecting old output does not hide active production');
  assert.equal(ui.requests.length, 0, 'changing the tracked result never creates another job');
});
