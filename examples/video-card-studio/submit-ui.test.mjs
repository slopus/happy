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
  children = [];
  dataset = {};
  value = '';
  disabled = false;
  hidden = false;
  className = '';
  ownText = '';
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.children = children; }
  setAttribute() {}
}

function setup({ crypto, fetchImpl } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
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
  const context = vm.createContext({
    document: { getElementById: element, createElement: () => new Element() },
    window: { addEventListener() {} },
    crypto: crypto ?? { randomUUID: () => job.id },
    EventSource, AbortController, URL, setTimeout, clearTimeout,
    fetch: async (...args) => {
      requests.push({ url: args[0], body: JSON.parse(args[1].body), signal: args[1].signal });
      return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ job }) };
    },
  });
  vm.runInContext(source, context, { filename: 'public/app.js' });
  element('video-url').value = job.bvid;
  return { element, requests, stream: streams[0], submit: () => element('submit-form').onsubmit({ preventDefault() {} }) };
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
