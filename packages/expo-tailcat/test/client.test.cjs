const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, normalizeOptions } = require('../src/client');

test('validates before touching the native module; errors do not disclose addresses', async () => {
  const client = createClient(() => { throw new Error('native loaded'); });
  for (const options of [null, {}, { address: 'secret invalid', port: 80 }, { address: 'tcabc', port: 0 },
    { address: 'tcabc', port: 1.5 }, { address: 'tcabc', port: 65536 },
    { address: 'tcabc', port: 80, scheme: 'file' }, { address: 'tcabc', port: 80, hostname: 'x/y' },
    { address: 'tcabc', port: 80, connectTimeoutMs: 1 }, { address: 'tcabc', port: 80, derpMapUrl: 'http://example.com' }]) {
    await assert.rejects(client.openTunnel(options), error => error instanceof TypeError && !error.message.includes('secret'));
  }
});

test('normalizes only documented options', () => {
  assert.deepEqual(normalizeOptions({ address: 'tcabc', port: 80, unknown: 'omit' }), { address: 'tcabc', port: 80 });
  assert.throws(() => normalizeOptions({ address: 'tcabc', port: 80, derpMapUrl: 'https://user:password@example.com' }));
});

test('returns immutable endpoints and closes once even concurrently', async () => {
  let closes = 0;
  const native = {
    openTunnel: async raw => {
      assert.deepEqual(JSON.parse(raw), { address: 'tcabc', port: 8080 });
      return JSON.stringify({ id: 'id', httpUrl: 'http://127.0.0.1:1/key/', wsUrl: 'ws://127.0.0.1:1/key/' });
    },
    closeTunnel: async id => { assert.equal(id, 'id'); closes++; },
  };
  const tunnel = await createClient(() => native).openTunnel({ address: 'tcabc', port: 8080 });
  assert.ok(Object.isFrozen(tunnel));
  assert.equal(tunnel.wsUrl, 'ws://127.0.0.1:1/key/');
  await Promise.all([tunnel.close(), tunnel.close()]);
  assert.equal(closes, 1);
});

test('close may be retried after bridge failure', async () => {
  let closes = 0;
  const native = {
    openTunnel: async () => '{"id":"id","httpUrl":"http://x/","wsUrl":"ws://x/"}',
    closeTunnel: async () => { if (++closes === 1) throw new Error('bridge failure'); },
  };
  const tunnel = await createClient(() => native).openTunnel({ address: 'tcabc', port: 80 });
  await assert.rejects(tunnel.close());
  await tunnel.close();
  assert.equal(closes, 2);
});

test('forwards close-all and lifecycle subscriptions', async () => {
  let closed = false;
  const subscription = { remove() {} };
  const listener = () => {};
  const client = createClient(() => ({
    closeAllTunnels: async () => { closed = true; },
    addListener: (event, callback) => {
      assert.equal(event, 'onTunnelsClosed'); assert.equal(callback, listener); return subscription;
    },
  }));
  await client.closeAllTunnels();
  assert.ok(closed);
  assert.equal(client.addTunnelsClosedListener(listener), subscription);
});