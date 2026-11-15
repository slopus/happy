import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceWorkerScope } from "./service-worker.js";
import { bypassesServiceWorker, installServiceWorker, SKIP_WAITING } from "./service-worker.js";

const ORIGIN = "https://app.example.com";
const CACHE = "rakazo-shell-current";

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(request: RequestInfo) {
    const url = new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
    return this.entries.get(url)?.clone();
  }
  async put(request: RequestInfo, response: Response) {
    this.entries.set(
      new URL(typeof request === "string" ? request : request.url, ORIGIN).href,
      response,
    );
  }
  async addAll(requests: Request[]) {
    for (const request of requests) await this.put(request, await network(request));
  }
}

let network: (request: Request) => Promise<Response>;

function setup(options: { precache?: string[]; windows?: number } = {}) {
  const stores = new Map<string, FakeCache>();
  const listeners = new Map<string, (event: unknown) => void>();
  const waiting = new EventTarget() as EventTarget & { postMessage: ReturnType<typeof vi.fn> };
  waiting.postMessage = vi.fn();
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const scope = {
    location: { origin: ORIGIN },
    caches: caches as unknown as CacheStorage,
    clients: { matchAll: async () => Array.from({ length: options.windows ?? 1 }) },
    registration: { waiting: null as typeof waiting | null },
    skipWaiting: vi.fn(async () => undefined),
    fetch: (request: Request) => network(request),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
  };
  installServiceWorker(scope as unknown as ServiceWorkerScope, options.precache ?? ["/"], CACHE);

  async function dispatch(type: string, extra: object) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners.get(type)!({
      ...extra,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    const result = await response;
    await Promise.all(pending);
    return result;
  }
  const request = (path: string, mode: RequestMode = "cors", method = "GET") =>
    // Request() refuses "navigate" as a mode, so pin it the way the browser would.
    Object.defineProperty(new Request(new URL(path, ORIGIN), { method }), "mode", { value: mode });
  return {
    stores,
    scope,
    waiting,
    dispatch,
    fetch: (path: string, mode?: RequestMode, method?: string) =>
      dispatch("fetch", { request: request(path, mode, method) }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("service worker", () => {
  it("never handles live data, auth callbacks or the screen proxy", async () => {
    network = vi.fn(async () => new Response("live"));
    const sw = setup();
    for (const path of ["/api/auth/callback/github?code=1", "/rpc/threads", "/novnc/session/x"]) {
      expect(await sw.fetch(path, "navigate")).toBeUndefined();
      expect(await sw.fetch(path)).toBeUndefined();
    }
    expect(await sw.fetch("/assets/app.js", "cors", "POST")).toBeUndefined();
    expect(await sw.fetch("https://cdn.example.com/assets/app.js")).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
    expect(bypassesServiceWorker("/apiary")).toBe(false);
  });

  it("precaches the shell and serves it for navigations while offline", async () => {
    network = async (request) => new Response(`network ${new URL(request.url).pathname}`);
    const sw = setup({ precache: ["/", "/assets/index-abc.js"] });
    await sw.dispatch("install", {});

    expect(await (await sw.fetch("/t/123", "navigate"))!.text()).toBe("network /t/123");
    network = async () => {
      throw new TypeError("offline");
    };
    expect(await (await sw.fetch("/t/123", "navigate"))!.text()).toBe("network /");
    expect(await (await sw.fetch("/assets/index-abc.js"))!.text()).toBe(
      "network /assets/index-abc.js",
    );
  });

  it("never answers an online navigation from the cached shell", async () => {
    network = async () => new Response("first deploy");
    const sw = setup({ precache: ["/"] });
    await sw.dispatch("install", {});
    network = async () => new Response("next deploy");
    expect(await (await sw.fetch("/", "navigate"))!.text()).toBe("next deploy");
    expect(await (await sw.fetch("/t/1", "navigate"))!.text()).toBe("next deploy");
  });

  it("fetches an instance theme fresh and keeps the last copy for offline reloads", async () => {
    network = async () => new Response("theme v1");
    const sw = setup();
    expect(await (await sw.fetch("/instance-theme.css"))!.text()).toBe("theme v1");
    network = async () => new Response("theme v2");
    expect(await (await sw.fetch("/instance-theme.css"))!.text()).toBe("theme v2");
    network = async () => {
      throw new TypeError("offline");
    };
    expect(await (await sw.fetch("/instance-theme.css"))!.text()).toBe("theme v2");
    await expect(sw.fetch("/instance-theme/font/0.woff2")).rejects.toThrow("offline");
  });

  it("falls back to the previous version's theme on an offline reload after an update", async () => {
    network = async () => {
      throw new TypeError("offline");
    };
    const sw = setup();
    const previous = await sw.scope.caches.open("rakazo-shell-20261022100000");
    await previous.put(`${ORIGIN}/instance-theme.css`, new Response("theme from last build"));
    expect(await (await sw.fetch("/instance-theme.css"))!.text()).toBe("theme from last build");
  });

  it("caches lazy assets as they load, but not an HTML fallback", async () => {
    network = async (request) =>
      request.url.endsWith("missing.js")
        ? new Response("<html>", { headers: { "content-type": "text/html" } })
        : new Response("chunk", { headers: { "content-type": "text/javascript" } });
    const sw = setup();
    await sw.fetch("/assets/lazy.js");
    await sw.fetch("/assets/missing.js");
    expect([...sw.stores.get(CACHE)!.entries.keys()]).toEqual([`${ORIGIN}/assets/lazy.js`]);
  });

  it("keeps only the current and newest previous shell caches on activate", async () => {
    network = async () => new Response("ok");
    const sw = setup();
    await sw.scope.caches.open("rakazo-shell-20261022100000");
    await sw.scope.caches.open("rakazo-shell-20261020100000");
    await sw.scope.caches.open("someone-else");
    await sw.scope.caches.open(CACHE);
    await sw.dispatch("activate", {});
    expect([...sw.stores.keys()]).toEqual(["rakazo-shell-20261022100000", "someone-else", CACHE]);
  });

  it("prefers a build-named previous shell over a legacy hash-named one", async () => {
    network = async () => new Response("ok");
    const sw = setup();
    await sw.scope.caches.open("rakazo-shell-abcdef0123456789");
    await sw.scope.caches.open("rakazo-shell-20261022100000");
    await sw.scope.caches.open(CACHE);
    await sw.dispatch("activate", {});
    expect([...sw.stores.keys()]).toEqual(["rakazo-shell-20261022100000", CACHE]);
  });

  it("serves an old-version asset from the previous cache after activation while offline", async () => {
    network = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const sw = setup();
    const previous = await sw.scope.caches.open("rakazo-shell-previous");
    await previous.put("/assets/old.js", new Response("previous bundle"));
    await sw.scope.caches.open(CACHE);
    await sw.dispatch("activate", {});

    expect(await (await sw.fetch("/assets/old.js"))!.text()).toBe("previous bundle");
    expect(network).not.toHaveBeenCalled();
  });

  it("hands over to a waiting version on the next navigation of the last window", async () => {
    network = vi.fn(async () => new Response("page"));
    const sw = setup();
    sw.scope.registration.waiting = sw.waiting;
    sw.waiting.postMessage.mockImplementation(() =>
      sw.waiting.dispatchEvent(new Event("statechange")),
    );

    const response = await sw.fetch("/", "navigate");
    expect(sw.waiting.postMessage).toHaveBeenCalledWith(SKIP_WAITING);
    expect(response!.headers.get("refresh")).toBe("0");
    expect(network).not.toHaveBeenCalled();

    await sw.dispatch("message", { data: SKIP_WAITING });
    expect(sw.scope.skipWaiting).toHaveBeenCalledOnce();
  });

  it("keeps the current version while other windows still use it", async () => {
    network = async () => new Response("page");
    const sw = setup({ windows: 2 });
    sw.scope.registration.waiting = sw.waiting;
    expect(await (await sw.fetch("/", "navigate"))!.text()).toBe("page");
    expect(sw.waiting.postMessage).not.toHaveBeenCalled();
  });

  it("loads the page normally when the waiting version does not take over", async () => {
    vi.useFakeTimers();
    network = async () => new Response("page");
    const sw = setup();
    sw.scope.registration.waiting = sw.waiting;
    const pending = sw.fetch("/", "navigate");
    await vi.runAllTimersAsync();
    expect(await (await pending)!.text()).toBe("page");
  });
});
