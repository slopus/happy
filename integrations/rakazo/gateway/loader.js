(() => {
  'use strict';
  let parentOrigin;
  let started = false;
  let exchanging = false;
  let dead = false;
  let memoryLease;
  const native = Boolean(window.ReactNativeWebView?.postMessage);
  const notify = (type, extra = {}) => {
    const message = { type: `paws:rakazo:${type}`, ...extra };
    if (native) window.ReactNativeWebView.postMessage(JSON.stringify(message));
    else window.parent.postMessage(message, parentOrigin || '*');
  };
  const fail = (message) => {
    if (dead) return;
    dead = true;
    notify('error', { message });
    const fallback = document.getElementById('paws-bootstrap-status');
    if (fallback) fallback.textContent = message;
  };
  // Native storage uses origin-wide space/session hints. Isolate each embedded client.
  // All chats, bots, files and settings remain in native Rakazo's database.
  const storage = new Map();
  const storageShim = {
    get length() { return storage.size; },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => storage.get(String(key)) ?? null,
    setItem: (key, value) => { storage.set(String(key), String(value)); },
    removeItem: (key) => { storage.delete(String(key)); },
    clear: () => storage.clear(),
  };
  try {
    Object.defineProperty(window, 'localStorage', { value: storageShim });
    Object.defineProperty(window, 'sessionStorage', { value: storageShim });
    if (window.BroadcastChannel) {
      const OriginalChannel = window.BroadcastChannel;
      const channelScope = crypto.randomUUID();
      window.BroadcastChannel = class extends OriginalChannel {
        constructor(name) { super(`paws:${channelScope}:${name}`); }
      };
    }
  } catch { fail('This browser cannot isolate the Bots account. Open Bots in a supported browser.'); return; }
  const bindWorker = async (session) => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) throw new Error('Bots requires a secure browser with Service Worker support.');
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Bots browser isolation could not start. Reload Bots.')); }, 10_000);
      const cleanup = () => { clearTimeout(timeout); navigator.serviceWorker.removeEventListener('controllerchange', changed); };
      const changed = () => { if (navigator.serviceWorker.controller) { cleanup(); resolve(); } };
      navigator.serviceWorker.addEventListener('controllerchange', changed);
      changed();
    });
    await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('Bots browser isolation did not acknowledge this session. Reload Bots.')); }, 10_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout); channel.port1.close();
        event.data?.ok && event.data.version === 1 ? resolve() : reject(new Error('This Bots frame is already bound to another launch. Reopen Bots.'));
      };
      navigator.serviceWorker.controller.postMessage({ type: 'paws:bind', ...session }, [channel.port2]);
    });
  };
  const launch = async (ticket, sourceOrigin, platform) => {
    if (started || exchanging || dead || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return;
    exchanging = true;
    try {
      const response = await fetch('/__paws/redeem', {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket, parentOrigin: sourceOrigin, platform }),
      });
      if (!response.ok) throw new Error('The Bots launch expired or was already used. Reopen Bots.');
      const session = await response.json();
      memoryLease = { sessionKey: session.sessionKey, expiresAt: session.expiresAt };
      await bindWorker(session);
      storage.set('rakazo:space-id', session.spaceId);
      if (session.appearance) {
        storage.set('rakazo.uiAppearance', session.appearance);
        const theme = session.appearance === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : session.appearance;
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
      }
      if (session.locale) {
        const locale = session.locale === 'zh' ? 'zh-CN' : 'en';
        storage.set('rakazo.uiLocale', locale);
        document.documentElement.lang = locale;
      }
      started = true;
      document.getElementById('paws-bootstrap-status')?.remove();
      for (const inert of document.querySelectorAll('script[type="application/paws-module"]')) {
        const script = document.createElement('script');
        for (const attribute of inert.attributes) if (attribute.name !== 'type') script.setAttribute(attribute.name, attribute.value);
        script.type = 'module';
        script.textContent = inert.textContent;
        inert.replaceWith(script);
      }
      notify('authenticated');
    } catch (error) { fail(error instanceof Error ? error.message : 'Bots could not start.'); }
  };
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.source !== navigator.serviceWorker.controller) return;
    if (event.data?.type === 'paws:restore-lease' && event.ports[0]) {
      event.ports[0].postMessage(!dead && memoryLease?.expiresAt > Date.now() ? memoryLease : null);
    }
    if (event.data?.type === 'paws:lease-lost') fail('Bots browser isolation restarted. Reopen Bots to reconnect.');
  });
  if (native) {
    Object.defineProperty(window, '__pawsRakazoLaunch', { value: (ticket) => launch(ticket, window.location.origin, 'native') });
  } else {
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || window.parent === window || event.data?.type !== 'paws:rakazo:launch') return;
      parentOrigin = event.origin;
      void launch(event.data.ticket, event.origin, 'web');
    });
  }
  const ready = () => { if (!dead) notify('ready'); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', ready, { once: true }) : ready();
})();
