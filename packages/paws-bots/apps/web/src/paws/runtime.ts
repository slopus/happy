/** Host integration is lexical to this bundle; it never patches window.fetch or storage. */
export type HostOptions = {
  runtimeUrl: string;
  ticket: string;
  expiresAt: number;
  onAuthenticated(): void;
  onFailure(): void;
  theme?: Record<string, string>;
};
let active: { origin: string; sessionKey: string; expiresAt: number; controller: AbortController; root: HTMLElement } | null = null;
let storageNamespace = "";
let navigate: ((path: string) => void) | undefined;
const nativeFetch = globalThis.fetch.bind(globalThis);
export const embedded = Boolean(import.meta.env.PAWS_EMBEDDED);

export function hostRuntimeOrigin() { return embedded && active ? active.origin : window.location.origin; }
/** Viewer shells remain network documents under their original CSP. Only these
 * public, self-contained shells may be loaded from the mounted Bots gateway. */
export function hostViewerUrl(path: "/html-viewer.html" | "/mcp-app-viewer.html"): string {
  if (path !== "/html-viewer.html" && path !== "/mcp-app-viewer.html") throw new Error("Unsupported Bots viewer");
  if (!embedded) return path;
  if (!active || active.controller.signal.aborted || Date.now() >= active.expiresAt) throw new Error("Bots session ended");
  return `${active.origin}${path}`;
}
export function hostRoot(): HTMLElement { if (!embedded) return document.documentElement; if (!active) throw new Error("Bots mount is unavailable"); return active.root; }
export function hostNavigate(path: string) { if (!embedded) { window.location.assign(path); return; } if (!active) return; if (path.startsWith("/") && !path.startsWith("//")) navigate?.(path); else window.location.assign(path); }
export function setHostNavigate(handler: (path: string) => void) { navigate = handler; }

export async function connect(root: HTMLElement, options: HostOptions) {
  if (active) throw new Error("A Bots mount is already active");
  const url = new URL(options.runtimeUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || options.expiresAt <= Date.now()) throw new Error("Invalid Bots launch");
  const controller = new AbortController();
  active = { origin: url.origin, sessionKey: "", expiresAt: options.expiresAt, controller, root };
  const response = await nativeFetch(`${url.origin}/__paws/redeem`, {
    method: "POST", credentials: "omit", redirect: "error", signal: controller.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket: options.ticket, parentOrigin: window.location.origin, platform: "web" }),
  });
  if (!response.ok) throw new Error("Bots authorization failed");
  const lease = await response.json();
  controller.signal.throwIfAborted();
  if (!/^[A-Za-z0-9_-]{43}$/.test(lease.sessionKey) || lease.expiresAt <= Date.now() || typeof lease.spaceId !== "string" || typeof lease.accountKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(lease.accountKey)) throw new Error("Invalid Bots session");
  active.sessionKey = lease.sessionKey; active.expiresAt = lease.expiresAt;
  // Native space id is deterministic per Paws account; no Paws credential enters this bundle.
  storageNamespace = `paws:bots:${url.origin}:${lease.accountKey}:${lease.spaceId}:`;
  localStore.setItem("rakazo:space-id", lease.spaceId);
  localStore.setItem("rakazo.uiLocale", lease.locale === "zh" ? "zh-CN" : "en");
  root.dataset.theme = lease.appearance === "dark" ? "dark" : "light";
}

export const pawsFetch: typeof fetch = async (input, init) => {
  if (!embedded) return nativeFetch(input, init);
  const state = active;
  if (!state || state.controller.signal.aborted || Date.now() >= state.expiresAt) throw new Error("Bots session ended");
  const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), window.location.origin), init);
  const url = new URL(request.url);
  // Only Rakazo API paths may receive its lease. Redirects cannot forward it elsewhere.
  const managed = [window.location.origin, state.origin].includes(url.origin) && /^\/(api|rpc)(\/|$)/.test(url.pathname);
  if (!managed) throw new Error("Unsupported Bots transport destination");
  url.host = new URL(state.origin).host; url.protocol = new URL(state.origin).protocol;
  const headers = new Headers(request.headers);
  headers.delete("authorization"); headers.delete("cookie");
  headers.set("x-paws-rakazo-session", state.sessionKey);
  const signals = [state.controller.signal, request.signal];
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.blob();
  return nativeFetch(url, { method: request.method, body, headers, credentials: "omit", redirect: "error", signal: AbortSignal.any(signals), keepalive: request.keepalive });
};

function namespacedStorage(storage: () => Storage): Storage {
  return {
    get length() { return Object.keys(storage()).filter(key => key.startsWith(storageNamespace)).length; },
    key(index) { return Object.keys(storage()).filter(key => key.startsWith(storageNamespace))[index]?.slice(storageNamespace.length) ?? null; },
    getItem(key) { return storage().getItem(storageNamespace + key); },
    setItem(key, value) { storage().setItem(storageNamespace + key, value); },
    removeItem(key) { storage().removeItem(storageNamespace + key); },
    clear() { const store = storage(); for (const key of Object.keys(store)) if (key.startsWith(storageNamespace)) store.removeItem(key); },
  };
}
export const localStore = namespacedStorage(() => window.localStorage);
export const sessionStore = namespacedStorage(() => window.sessionStorage);

export function disconnect() {
  const state = active;
  if (!state) return;
  state.controller.abort();
  if (state.sessionKey) void nativeFetch(`${state.origin}/api/auth/sign-out`, {
    method: "POST", credentials: "omit", redirect: "error", keepalive: true,
    headers: { "x-paws-rakazo-session": state.sessionKey },
  }).catch(() => undefined);
  active = null; navigate = undefined;
}

export const listenWindow: Window["addEventListener"] = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  const base = typeof options === "boolean" ? { capture: options } : options;
  window.addEventListener(type, listener, { ...base, ...(active ? { signal: active.controller.signal } : {}) });
};

export function scopedStorageKey(key: string) { return storageNamespace + key; }
export function isLocalStorageEvent(event: StorageEvent) { try { return event.storageArea === window.localStorage; } catch { return false; } }

export function ownsHostKeyboard(event: KeyboardEvent) {
  if (!embedded) return true;
  if (!active || active.root.dataset.pawsActive === "false") return false;
  return event.composedPath().includes(active.root) ||
    (typeof document !== "undefined" && event.target === document.body && active.root.isConnected);
}
