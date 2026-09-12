import { registerRootComponent } from 'expo';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { openTunnel, closeAllTunnels } from 'expo-tailcat';

const control = 'http://127.0.0.1:18081';
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const deadline = (promise, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Test operation timed out')), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

async function runTests(progress) {
  const completed = [];
  const config = await (await fetch(control + '/config')).json();
  const options = { ...config, connectTimeoutMs: 10000 };
  let tunnel;
  try {
    tunnel = await openTunnel(options);
    progress('HTTP');
    const response = await fetch(tunnel.httpUrl + 'health');
    assert(response.status === 200 && (await response.json()).status === 'ok', 'HTTP GET failed');
    completed.push('HTTP GET through private DERP');

    const bytes = new Uint8Array(256 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const echo = await fetch(tunnel.httpUrl + 'echo?x=1%2F2', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer test-only' },
      body: bytes.buffer,
    });
    const echoed = new Uint8Array(await echo.arrayBuffer());
    assert(echo.status === 201 && echoed.length === bytes.length && echoed.every((b, i) => b === bytes[i]), 'Binary POST failed');
    assert(echo.headers.get('x-upstream-auth') === 'Bearer test-only', 'Application authorization was not preserved');
    assert(echo.headers.get('x-upstream-query') === 'x=1%2F2', 'Query encoding changed');
    completed.push('Binary POST, status, auth and query');

    const redirected = await fetch(tunnel.httpUrl + 'redirect');
    assert((await redirected.json()).query === 'redirected=yes', 'Redirect failed');
    const denied = await fetch(new URL('/health', tunnel.httpUrl).href);
    assert(denied.status === 404, 'Endpoint accepted a request without its capability');
    completed.push('Redirect and capability isolation');

    const abort = new AbortController();
    const request = fetch(tunnel.httpUrl + 'slow', { signal: abort.signal });
    const timer = setTimeout(() => abort.abort(), 50);
    let cancelled = false;
    try { await request; } catch { cancelled = true; } finally { clearTimeout(timer); }
    assert(cancelled, 'HTTP cancellation failed');
    completed.push('HTTP cancellation');

    progress('WebSocket');
    const ws = new WebSocket(tunnel.wsUrl + 'ws', ['tailcat-test']);
    ws.binaryType = 'arraybuffer';
    await deadline(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('WebSocket connection failed')); }));
    assert(ws.protocol === 'tailcat-test', 'WebSocket subprotocol missing');
    const receive = () => deadline(new Promise((resolve, reject) => {
      ws.onmessage = event => resolve(event.data);
      ws.onerror = () => reject(new Error('WebSocket message failed'));
    }));
    let received = receive();
    ws.send('hello tailcat');
    assert(await received === 'hello tailcat', 'WebSocket text failed');
    received = receive();
    ws.send(new Uint8Array([0, 128, 255]).buffer);
    const binary = new Uint8Array(await received);
    assert(binary.length === 3 && binary[0] === 0 && binary[1] === 128 && binary[2] === 255, 'WebSocket binary failed');
    completed.push('WebSocket text, binary and subprotocol');

    const closed = deadline(new Promise(resolve => { ws.onclose = resolve; }));
    await tunnel.close();
    await closed;
    await tunnel.close();
    completed.push('Idempotent close terminates WebSocket');

    tunnel = await openTunnel(options);
    await closeAllTunnels();
    tunnel = await openTunnel(options);
    assert((await fetch(tunnel.httpUrl + 'health')).status === 200, 'Reopen failed');
    await tunnel.close();
    completed.push('Close-all and reopen');
    return { ok: true, completed };
  } finally {
    await closeAllTunnels();
  }
}

function App() {
  const [status, setStatus] = useState('Starting');
  useEffect(() => {
    let live = true;
    deadline(runTests(value => { if (live) setStatus(value); }), 120000)
      .then(async result => {
        await fetch(control + '/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
        if (live) setStatus('PASS');
      })
      .catch(async error => {
        // Never report native endpoint URLs, Tailcat addresses, or arbitrary network errors.
        const result = { ok: false, error: 'Native E2E failed', stage: String(error?.message || 'unknown').replace(/(?:https?|wss?):\/\/\S+|tc[A-Za-z0-9_-]{20,}/g, '[redacted]') };
        try { await fetch(control + '/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }); } catch {}
        if (live) setStatus('FAIL');
      });
    return () => { live = false; };
  }, []);
  return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><Text accessibilityLabel="test-status">{status}</Text></View>;
}

registerRootComponent(App);