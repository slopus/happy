import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { fetch as undiciFetch } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeWebUrl,
  fetchSafeWebBytes,
  fetchSafeWebText,
  isBlockedHostname,
} from "./web-ssrf.js";

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("web SSRF policy", () => {
  it.each([
    "http://localhost/x",
    "https://127.0.0.1/x",
    "http://10.0.0.1/x",
    "https://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "http://[::]/",
    "file:///etc/passwd",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(assertSafeWebUrl(url, publicResolver)).rejects.toThrow();
  });

  it("accepts public http and https URLs", async () => {
    await expect(assertSafeWebUrl("https://example.test/page", publicResolver)).resolves.toEqual(
      new URL("https://example.test/page"),
    );
    await expect(assertSafeWebUrl("http://example.test/page", publicResolver)).resolves.toEqual(
      new URL("http://example.test/page"),
    );
  });

  it("rejects hosts that resolve privately", async () => {
    await expect(
      assertSafeWebUrl("https://example.test/page", async () => [
        { address: "10.1.2.3", family: 4 as const },
      ]),
    ).rejects.toThrow(/private address/i);
  });

  it("blocks private hostnames before DNS", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("127.0.0.1")).toBe(true);
    expect(isBlockedHostname("10.2.3.4")).toBe(true);
    expect(isBlockedHostname("192.168.0.9")).toBe(true);
    expect(isBlockedHostname("169.254.1.1")).toBe(true);
    expect(isBlockedHostname("::1")).toBe(true);
    expect(isBlockedHostname("example.test")).toBe(false);
  });

  it("re-validates redirect targets and blocks redirect-to-private", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const href = String(input);
      if (href === "https://example.test/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    await expect(
      fetchSafeWebText("https://example.test/start", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
      }),
    ).rejects.toThrow(/private|internal/i);
  });

  it("follows a public redirect and returns the final body", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const href = String(input);
      if (href === "https://example.test/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.test/final" },
        });
      }
      if (href === "https://example.test/final") {
        return new Response("<html><title>Ok</title><body>hello</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const result = await fetchSafeWebText("https://example.test/start", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    expect(result.url).toBe("https://example.test/final");
    expect(result.body).toContain("hello");
  });

  it.each(["text/html; charset=gbk", 'Text/HTML; CHARSET="GBK"'])(
    "decodes the declared charset in %s",
    async (contentType) => {
      // GBK bytes for 中文, used in both the title and the page body.
      const chinese = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
      const body = Buffer.concat([
        Buffer.from("<title>"),
        chinese,
        Buffer.from("</title><p>"),
        chinese,
        Buffer.from("</p>"),
      ]);
      const result = await fetchSafeWebText("https://example.test/page", {
        fetch: async () => new Response(body, { headers: { "content-type": contentType } }),
        resolveHostname: publicResolver,
      });
      expect(result.body).toBe("<title>中文</title><p>中文</p>");
      expect(result.contentType).toBe(contentType);
    },
  );

  it("uses the final response charset after a redirect", async () => {
    const result = await fetchSafeWebText("https://example.test/start", {
      fetch: async (url) =>
        String(url).endsWith("/start")
          ? new Response(null, {
              status: 302,
              headers: { location: "/final", "content-type": "text/html; charset=utf-8" },
            })
          : new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
              headers: { "content-type": "text/plain; charset=iso-8859-1" },
            }),
      resolveHostname: publicResolver,
    });
    expect(result.url).toBe("https://example.test/final");
    expect(result.body).toBe("café");
  });

  it.each([
    null,
    "text/html",
    "text/plain; charset=utf-8",
    "text/plain; charset=",
    "text/plain; charset=not-an-encoding",
    "not a media type",
    'text/plain; note="ignore; charset=gbk"',
  ])("keeps the UTF-8 default for %s", async (contentType) => {
    const result = await fetchSafeWebText("https://example.test/page", {
      fetch: async () =>
        new Response(new TextEncoder().encode("中文 café"), {
          headers: contentType ? { "content-type": contentType } : {},
        }),
      resolveHostname: publicResolver,
    });
    expect(result.body).toBe("中文 café");
  });

  it("still limits the encoded byte count before decoding", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), {
        headers: { "content-type": "text/plain; charset=gbk" },
      });
    const options = { fetch: fetchMock, resolveHostname: publicResolver, maxBytes: 2 };
    await expect(fetchSafeWebText("https://example.test/page", options)).rejects.toThrow(
      /too large/i,
    );
    await expect(
      fetchSafeWebText("https://example.test/page", { ...options, truncate: true }),
    ).resolves.toMatchObject({ body: "中" });
    await expect(
      fetchSafeWebBytes("https://example.test/page", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
      }),
    ).resolves.toMatchObject({ body: new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]) });
  });

  it("refuses ports outside allowedPorts on every hop", async () => {
    await expect(
      assertSafeWebUrl("https://example.test:8443/", publicResolver, undefined, [80, 443]),
    ).rejects.toThrow(/port/i);
    await expect(
      assertSafeWebUrl("https://example.test/", publicResolver, undefined, [80, 443]),
    ).resolves.toBeInstanceOf(URL);

    const fetched: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      fetched.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://example.test:6379/" },
      });
    };
    await expect(
      fetchSafeWebBytes("https://example.test/", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        allowedPorts: [80, 443],
      }),
    ).rejects.toThrow(/port/i);
    expect(fetched).toEqual(["https://example.test/"]);
  });

  it("keeps the first maxBytes of a longer body when truncating", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("a".repeat(5000), { status: 200, headers: { "content-length": "5000" } });

    const result = await fetchSafeWebBytes("https://example.test/", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
      maxBytes: 100,
      truncate: true,
    });
    expect(result.body.byteLength).toBe(100);
    await expect(
      fetchSafeWebBytes("https://example.test/", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("rejects an error status instead of returning its body", async () => {
    await expect(
      fetchSafeWebBytes("https://example.test/", {
        fetch: async () => new Response("not found page", { status: 404 }),
        resolveHostname: publicResolver,
      }),
    ).rejects.toThrow("Request failed: HTTP 404");
  });

  it("stops at maxRedirects", async () => {
    const fetched: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      fetched.push(String(input));
      return new Response(null, { status: 302, headers: { location: `/${fetched.length}` } });
    };
    await expect(
      fetchSafeWebBytes("https://example.test/", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        maxRedirects: 1,
      }),
    ).rejects.toThrow(/too many redirects/i);
    expect(fetched).toHaveLength(2);
  });

  it("drops caller-provided headers on cross-origin redirects", async () => {
    let finalHeaders = new Headers();
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://example.test") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example.test/final" },
        });
      }
      finalHeaders = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    };

    await fetchSafeWebText("https://example.test/start", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
      headers: {
        Authorization: "Bearer stored",
        "X-Api-Key": "stored-key",
        "X-Trace-Id": "trace-1",
      },
    });

    expect(finalHeaders.get("authorization")).toBeNull();
    expect(finalHeaders.get("x-api-key")).toBeNull();
    expect(finalHeaders.get("x-trace-id")).toBeNull();
  });

  it("drives the guarded dispatcher with a fetch from the same undici", async () => {
    // See remote-mcp.test: failing inside the lookup proves the request was
    // dispatched through the Agent rather than rejected by a mismatched fetch.
    // Omitting fetch, passing the builtin, and passing a captured builtin must
    // all use the package fetch that matches the Agent.
    expect(undiciFetch).not.toBe(globalThis.fetch);
    const captured = globalThis.fetch;
    for (const injected of [undefined, globalThis.fetch, captured] as const) {
      let resolutions = 0;
      await expect(
        fetchSafeWebText("https://example.test/start", {
          fetch: injected,
          resolveHostname: async () => {
            resolutions += 1;
            if (resolutions > 1) throw new Error("lookup reached");
            return [{ address: "203.0.113.10", family: 4 as const }];
          },
        }),
      ).rejects.toMatchObject({ cause: { message: "lookup reached" } });
    }
  });

  it("refuses a host that rebinds to loopback between the check and the connection", async () => {
    // No fetch seam: the real dispatcher and its connect-time lookup run against a real
    // listener. The name checks out as public, then resolves to the listener at connect time.
    const listener = createServer((_request, response) => response.end("reached"));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as AddressInfo;
    // Count TCP connections this process opens to the listener, whatever happens on
    // the socket afterwards: a local tool probing the port runs in another process and
    // cannot change the count, while a dispatcher that connects before failing counts.
    const clientConnections = trackConnectionsTo(port);
    let resolutions = 0;
    try {
      await expect(
        fetchSafeWebBytes(`http://rebind.test:${port}/`, {
          resolveHostname: async () => {
            resolutions += 1;
            return resolutions === 1
              ? [{ address: "203.0.113.10", family: 4 }]
              : [{ address: "127.0.0.1", family: 4 }];
          },
        }),
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/private address/) } });
      expect(resolutions).toBe(2);
      expect(clientConnections.count()).toBe(0);
    } finally {
      clientConnections.restore();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it("rejects oversized Content-Length before reading", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("ignored", {
        status: 200,
        headers: { "content-length": String(10 * 1024 * 1024) },
      });
    await expect(
      fetchSafeWebText("https://example.test/big", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("aborts while streaming once maxBytes is exceeded", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600).fill(65));
        controller.enqueue(new Uint8Array(600).fill(66));
        controller.close();
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    await expect(
      fetchSafeWebText("https://example.test/stream", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("readBodyCapped stops once the byte budget is exceeded", async () => {
    const { readBodyCapped } = await import("./web-ssrf.js");
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(400).fill(1));
          return;
        }
        if (pulls === 2) {
          controller.enqueue(new Uint8Array(400).fill(2));
          return;
        }
        controller.enqueue(new Uint8Array(400).fill(3));
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200 });
    await expect(readBodyCapped(response, 500)).rejects.toThrow(/too large/i);
    // Second chunk already exceeds; a third pull must not be needed.
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it("readBodyCapped does not wait for a hanging stream cancellation", async () => {
    const { readBodyCapped } = await import("./web-ssrf.js");
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(501));
        },
        cancel,
      }),
    );

    await expect(readBodyCapped(response, 500)).rejects.toThrow(/too large/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts a streamed body that stays under maxBytes", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const result = await fetchSafeWebText("https://example.test/ok", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
      maxBytes: 100,
    });
    expect(result.body).toBe("hello world");
  });

  it("uses one deadline across the whole redirect chain", async () => {
    let hops = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      hops += 1;
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
      const href = String(input);
      if (href.endsWith("/a")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.test/b" },
        });
      }
      if (href.endsWith("/b")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.test/c" },
        });
      }
      return new Response("done", { status: 200 });
    };

    await expect(
      fetchSafeWebText("https://example.test/a", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 100,
      }),
    ).rejects.toThrow();
    // Per-hop 100ms would allow all three hops; one shared deadline stops earlier.
    expect(hops).toBeLessThan(3);
  });

  it("cancels redirect response bodies before following the next hop", async () => {
    let cancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("redirect-body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock: typeof fetch = async (input) => {
      const href = String(input);
      if (href.endsWith("/start")) {
        return new Response(redirectBody, {
          status: 302,
          headers: { location: "https://example.test/final" },
        });
      }
      return new Response("ok", { status: 200 });
    };

    const result = await fetchSafeWebText("https://example.test/start", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    expect(result.body).toBe("ok");
    expect(cancelled).toBe(true);
  });

  it("aborts a hanging response body under the shared deadline", async () => {
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes — simulates a fetch body that ignores abort
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(hangingBody, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    let destroyed = false;
    const started = Date.now();
    await expect(
      fetchSafeWebText("https://example.test/hang", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 40,
        destroy: () => {
          destroyed = true;
        },
      }),
    ).rejects.toThrow();
    expect(destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("aborts when fetch itself ignores the abort signal", async () => {
    const fetchMock: typeof fetch = async () =>
      new Promise(() => {
        // never settles — ignores init.signal
      });

    let destroyed = false;
    const started = Date.now();
    await expect(
      fetchSafeWebText("https://example.test/hang-fetch", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 40,
        destroy: () => {
          destroyed = true;
        },
      }),
    ).rejects.toThrow();
    expect(destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("finishes when the deadline fires despite hanging body cancel and close", async () => {
    let bodyCancelStarted = false;
    let cleanupStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes
      },
      cancel() {
        bodyCancelStarted = true;
        return new Promise(() => {
          // never settles
        });
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(hangingBody, {
        status: 302,
        headers: { location: "https://example.test/next" },
      });

    let destroyed = false;
    const started = Date.now();
    await expect(
      fetchSafeWebText("https://example.test/start", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 40,
        cleanup: () => {
          cleanupStarted = true;
          return new Promise(() => {
            // hanging dispatcher.close()
          });
        },
        destroy: () => {
          destroyed = true;
        },
      }),
    ).rejects.toThrow();
    expect(bodyCancelStarted).toBe(true);
    expect(cleanupStarted).toBe(true);
    expect(destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("swallows a rejecting destroy promise without extending the deadline", async () => {
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(hangingBody, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    let destroyCalled = false;
    const started = Date.now();
    await expect(
      fetchSafeWebText("https://example.test/hang", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 40,
        destroy: () => {
          destroyCalled = true;
          return Promise.reject(new Error("destroy failed"));
        },
      }),
    ).rejects.toThrow();
    expect(destroyCalled).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("aborts stalled DNS under the shared deadline", async () => {
    let resolveCalls = 0;
    const stalledResolver = () =>
      new Promise<Array<{ address: string; family: number }>>((resolve) => {
        resolveCalls += 1;
        setTimeout(() => resolve([{ address: "203.0.113.10", family: 4 }]), 500);
      });

    await expect(
      fetchSafeWebText("https://example.test/slow-dns", {
        fetch: async () => new Response("nope", { status: 200 }),
        resolveHostname: stalledResolver,
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
    expect(resolveCalls).toBe(1);
  });
});

/**
 * Counts TCP connections this process opens to `port` by watching every socket the
 * process itself connects, independent of HTTP: a local tool probing the port from
 * another process never passes through here, and a socket that connected and then
 * failed still counts.
 */
function trackConnectionsTo(port: number) {
  const realConnect = Socket.prototype.connect as (...args: unknown[]) => unknown;
  let connections = 0;
  const countSocket = function (this: Socket, ...args: unknown[]) {
    if (connectTargetPort(args) === port) {
      this.on("connect", () => {
        connections += 1;
      });
    }
    return realConnect.apply(this, args);
  };
  const spy = vi.spyOn(Socket.prototype, "connect").mockImplementation(countSocket as never);
  return { count: () => connections, restore: () => spy.mockRestore() };
}

/** The destination port of a `Socket.prototype.connect` call, in either argument shape. */
function connectTargetPort(args: unknown[]): number | undefined {
  let [first] = args;
  if (Array.isArray(first)) [first] = first; // node's normalized [options, listener] pair
  if (typeof first === "number") return first;
  if (first && typeof first === "object" && "port" in first) {
    const { port } = first as { port?: number | string };
    if (typeof port === "number") return port;
    if (typeof port === "string") return Number.parseInt(port, 10);
  }
  return undefined;
}

describe("outbound proxy", () => {
  async function withConnectProxy(
    run: (proxy: { proxied: string[]; hosts: string[]; connectHosts: string[] }) => Promise<void>,
  ): Promise<void> {
    const proxied: string[] = [];
    const connectHosts: string[] = [];
    const hosts: string[] = [];
    const target = createServer((request, response) => {
      hosts.push(request.headers.host ?? "");
      response.end("ok");
    });
    const proxy = createServer((request, response) => {
      proxied.push(request.url ?? "");
      response.writeHead(405).end();
    });
    proxy.on("connect", (request, client) => {
      proxied.push(request.url ?? "");
      connectHosts.push(request.headers.host ?? "");
      const upstream = new Socket();
      upstream.connect((target.address() as AddressInfo).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client).pipe(upstream);
      });
    });
    await Promise.all(
      [target, proxy].map(
        (server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done)),
      ),
    );
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    vi.stubEnv("HTTP_PROXY", proxyUrl);
    vi.stubEnv("http_proxy", proxyUrl);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    try {
      await run({ proxied, hosts, connectHosts });
    } finally {
      vi.unstubAllEnvs();
      proxy.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([target, proxy].map((server) => new Promise((done) => server.close(done))));
    }
  }

  it("tunnels to the checked address and keeps the original host", async () => {
    await withConnectProxy(async ({ proxied, hosts, connectHosts }) => {
      const response = await fetchSafeWebText("http://example.test/page", {
        resolveHostname: publicResolver,
      });

      expect(response.body).toBe("ok");
      expect(proxied).toEqual(["203.0.113.10:80"]);
      expect(connectHosts).toEqual(["203.0.113.10:80"]);
      expect(hosts).toEqual(["example.test"]);
    });
  });

  it("refuses a host that rebinds to a private address before the proxy is asked", async () => {
    await withConnectProxy(async ({ proxied }) => {
      let calls = 0;
      const rebinding = async () => [
        { address: calls++ === 0 ? "203.0.113.10" : "127.0.0.1", family: 4 as const },
      ];

      await expect(
        fetchSafeWebText("http://rebind.example.test/page", { resolveHostname: rebinding }),
      ).rejects.toThrow();
      expect(proxied).toEqual([]);
    });
  });

  it("refuses a SOCKS proxy, which would resolve the hostname itself", async () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://127.0.0.1:1080");
    vi.stubEnv("https_proxy", "socks5://127.0.0.1:1080");
    try {
      await expect(
        fetchSafeWebText("https://example.test/page", { resolveHostname: publicResolver }),
      ).rejects.toThrow("Only HTTP proxies are supported");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
