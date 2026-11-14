import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('loader withholds native modules until exact parent launch and worker binding', async () => {
  const handlers = {}, workerHandlers = {};
  const notifications = [], fetches = [], scripts = [];
  let loaded;
  const moduleLoaded = new Promise((resolve) => { loaded = resolve; });
  const controller = { postMessage(message, ports) {
    assert.equal(message.type, 'paws:bind');
    ports[0].postMessage({ ok: true, version: 1 });
  } };
  const parent = { postMessage(message, target) { notifications.push({ message, target }); } };
  const window = { parent, location: { origin: 'https://bots.test' }, isSecureContext: true,
    addEventListener(name, callback) { handlers[name] = callback; },
  };
  const doc = { readyState: 'complete', documentElement: { lang: 'en', dataset: {}, style: {} },
    getElementById() { return { remove() {} }; },
    querySelectorAll() { return [{ attributes: [{ name: 'type', value: 'application/paws-module' }, { name: 'src', value: '/assets/native.js' }], textContent: '', replaceWith(script) { scripts.push(script); loaded(); } }]; },
    createElement() { return { setAttribute(name, value) { this[name] = value; } }; },
  };
  const navigator = { serviceWorker: { controller, register: async () => ({}), ready: Promise.resolve(),
    addEventListener(name, callback) { workerHandlers[name] = callback; },
  } };
  const lease = { sessionKey: 'k'.repeat(43), expiresAt: Date.now() + 60_000, spaceId: 'alice-space', appearance: 'dark', locale: 'zh' };
  const context = vm.createContext({ window, document: doc, navigator, Map, Object, Date, MessageChannel, setTimeout, clearTimeout,
    fetch: async (url, init) => { fetches.push({ url, init }); return { ok: true, json: async () => lease }; },
  });
  vm.runInContext(readFileSync(new URL('./loader.js', import.meta.url), 'utf8'), context);
  assert.equal(scripts.length, 0);
  assert.equal(notifications[0].message.type, 'paws:rakazo:ready');
  handlers.message({ source: {}, origin: 'https://paws.test', data: { type: 'paws:rakazo:launch', ticket: 't'.repeat(43) } });
  assert.equal(fetches.length, 0);
  handlers.message({ source: parent, origin: 'https://paws.test', data: { type: 'paws:rakazo:launch', ticket: 't'.repeat(43) } });
  await moduleLoaded;
  assert.equal(fetches[0].url, '/__paws/redeem');
  assert.equal(JSON.parse(fetches[0].init.body).parentOrigin, 'https://paws.test');
  assert.equal(scripts[0].type, 'module');
  assert.equal(scripts[0].src, '/assets/native.js');
  assert.equal(window.localStorage.getItem('rakazo:space-id'), 'alice-space');
  assert.equal(window.localStorage.getItem('rakazo.uiLocale'), 'zh-CN');
  assert.equal(window.localStorage.getItem('rakazo.uiAppearance'), 'dark');
  assert.equal(window.localStorage.getItem('sessionKey'), null);
  assert.equal(notifications.at(-1).target, 'https://paws.test');
  let restored;
  workerHandlers.message({ source: {}, data: { type: 'paws:restore-lease' }, ports: [{ postMessage(value) { restored = value; } }] });
  assert.equal(restored, undefined);
  workerHandlers.message({ source: controller, data: { type: 'paws:restore-lease' }, ports: [{ postMessage(value) { restored = value; } }] });
  assert.equal(restored.sessionKey, lease.sessionKey);
});
