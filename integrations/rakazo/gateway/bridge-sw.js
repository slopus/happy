/* This replaces Rakazo's root PWA worker. It caches neither documents nor private data. */
const leases = new Map();
const PRIVATE = /^\/(?:api|rpc)(?:\/|$)/;
const validLease = (lease) => Boolean(lease && /^[A-Za-z0-9_-]{43}$/.test(lease.sessionKey) && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt > Date.now());
async function leaseForClient(clientId) {
  let lease = leases.get(clientId);
  if (validLease(lease)) return lease;
  leases.delete(clientId);
  const client = await self.clients.get(clientId);
  if (!client) return null;
  // Workers can be terminated while idle. Only the original document may restore
  // its own lease from its JS closure; there is no origin-wide/persistent fallback.
  lease = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); resolve(null); }, 3000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout); channel.port1.close();
      resolve(validLease(event.data) ? event.data : null);
    };
    client.postMessage({ type: 'paws:restore-lease' }, [channel.port2]);
  });
  if (validLease(lease)) leases.set(clientId, lease);
  return lease;
}
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'paws:bind' || !event.source?.id || !event.ports[0]) return;
  const source = new URL(event.source.url);
  if (source.origin !== self.location.origin) return;
  const { sessionKey, expiresAt } = event.data;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionKey) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return;
  for (const [id, lease] of leases) if (lease.expiresAt <= Date.now()) leases.delete(id);
  const existing = leases.get(event.source.id);
  if (existing && existing.sessionKey !== sessionKey) {
    event.ports[0].postMessage({ ok: false });
    return;
  }
  leases.set(event.source.id, { sessionKey, expiresAt });
  event.ports[0].postMessage({ ok: true, version: 1 });
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !PRIVATE.test(url.pathname)) return;
  event.respondWith((async () => {
    const lease = await leaseForClient(event.clientId);
    if (!validLease(lease)) {
      leases.delete(event.clientId);
      const client = await self.clients.get(event.clientId);
      client?.postMessage({ type: 'paws:lease-lost' });
      return new Response(JSON.stringify({ error: 'Paws Bots session expired; reopen Bots' }), {
        status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    const headers = new Headers(event.request.headers);
    headers.set('x-paws-rakazo-session', lease.sessionKey);
    headers.delete('authorization');
    return fetch(new Request(event.request, { headers, credentials: 'omit', cache: 'no-store' }));
  })());
});
