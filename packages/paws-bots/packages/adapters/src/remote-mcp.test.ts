import dns from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { fetch as undiciFetch } from "undici";
import { describe, expect, it, vi } from "vitest";
import { MAX_MCP_RESPONSE_BYTES } from "./mcp-response-limit.js";
import {
  assertSafeRemoteUrl,
  ConnectorRedirectError,
  callRemoteMcpTool,
  createPrivateNetworkFetch,
  createSafeLookup,
  createSafeRemoteFetch,
  limitRemoteMcpPayload,
  RemoteRequestSentError,
} from "./remote-mcp.js";
import { toolCompletionAuditPayload } from "./tool-completion-audit.js";

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("remote MCP URL policy", () => {
  it("accepts public HTTPS endpoints", async () => {
    await expect(
      assertSafeRemoteUrl("https://connectors.example.test/mcp", publicResolver),
    ).resolves.toEqual(new URL("https://connectors.example.test/mcp"));
  });

  it("accepts public HTTPS endpoints when the private-endpoint escape is on", async () => {
    await expect(
      assertSafeRemoteUrl("https://connectors.example.test/mcp", publicResolver, {
        allowPrivateEndpoint: true,
      }),
    ).resolves.toEqual(new URL("https://connectors.example.test/mcp"));
  });

  it("blocks private hosts by default", async () => {
    await expect(assertSafeRemoteUrl("https://10.0.0.8/mcp", publicResolver)).rejects.toThrow(
      "Connector URL targets a private host. Set MCP_ALLOW_PRIVATE_ENDPOINT=true on the API and worker to allow it.",
    );
    await expect(
      assertSafeRemoteUrl("http://192.168.1.20:3927/mcp", publicResolver),
    ).rejects.toThrow(
      "Connector URL must use HTTPS. Set MCP_ALLOW_PRIVATE_ENDPOINT=true on the API and worker to allow it.",
    );
    await expect(
      assertSafeRemoteUrl("https://host.docker.internal/mcp", publicResolver),
    ).rejects.toThrow(/private host/i);
    await expect(assertSafeRemoteUrl("http://203.0.113.10/mcp", publicResolver)).rejects.toThrow(
      /^Connector URL must use HTTPS$/,
    );
  });

  it("offers the private-endpoint setting only where it decides the outcome before DNS", async () => {
    const hint = "Set MCP_ALLOW_PRIVATE_ENDPOINT=true on the API and worker to allow it.";
    for (const raw of ["http://localhost:3927/mcp", "http://127.0.0.1:3927/mcp"]) {
      await expect(assertSafeRemoteUrl(raw, publicResolver)).rejects.toThrow(hint);
    }
    // A private-looking name can still resolve to a public address, which the setting does not allow over HTTP.
    await expect(assertSafeRemoteUrl("http://mcp.internal/mcp", publicResolver)).rejects.toThrow(
      /^Connector URL must use HTTPS$/,
    );
    await expect(
      assertSafeRemoteUrl("http://mcp.internal/mcp", publicResolver, {
        allowPrivateEndpoint: true,
      }),
    ).rejects.toThrow("Connector URL must use HTTPS");
    await expect(assertSafeRemoteUrl("https://mcp.internal/mcp", publicResolver)).rejects.toThrow(
      /^Connector URL targets a private host$/,
    );
  });

  it("does not offer the private-endpoint setting for link-local hosts it would not allow", async () => {
    for (const raw of [
      "https://169.254.10.20/mcp",
      "https://[fe80::1]/mcp",
      "http://169.254.10.20/mcp",
    ]) {
      await expect(assertSafeRemoteUrl(raw, publicResolver)).rejects.toThrow(
        /^Connector URL (targets a private host|must use HTTPS)$/,
      );
      await expect(
        assertSafeRemoteUrl(raw, publicResolver, { allowPrivateEndpoint: true }),
      ).rejects.toThrow("Connector URL resolves to a private address");
    }
  });

  it("allows private LAN hosts when the deployment-owner escape is enabled", async () => {
    await expect(
      assertSafeRemoteUrl("https://10.0.0.8/mcp", publicResolver, { allowPrivateEndpoint: true }),
    ).resolves.toEqual(new URL("https://10.0.0.8/mcp"));
    await expect(
      assertSafeRemoteUrl("http://192.168.1.20:3927/mcp", publicResolver, {
        allowPrivateEndpoint: true,
      }),
    ).resolves.toEqual(new URL("http://192.168.1.20:3927/mcp"));
    await expect(
      assertSafeRemoteUrl(
        "http://host.docker.internal:3927/mcp",
        async () => [{ address: "192.168.65.254", family: 4 as const }],
        {
          allowPrivateEndpoint: true,
        },
      ),
    ).resolves.toEqual(new URL("http://host.docker.internal:3927/mcp"));
  });

  it.each([
    "https://169.254.169.254/latest/meta-data",
    "https://169.254.170.2/latest/meta-data",
    "https://100.100.100.200/latest/meta-data",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://metadata.goog/",
  ])(
    "still blocks cloud metadata %s when the private-endpoint escape is enabled",
    async (endpoint) => {
      await expect(
        assertSafeRemoteUrl(endpoint, publicResolver, {
          allowPrivateEndpoint: true,
        }),
      ).rejects.toThrow(/private host/i);
    },
  );

  it.each([
    "http://[::ffff:a9fe:aa02]/credentials",
    "https://[::ffff:169.254.170.2]/credentials",
    "http://[::ffff:a9fe:1234]/mcp",
    "https://[fe80::1234]/mcp",
  ])("blocks link-local literals with private endpoints enabled: %s", async (endpoint) => {
    const resolve = vi.fn(publicResolver);
    const fetch = vi.fn();
    const safeFetch = createSafeRemoteFetch(fetch, resolve, { allowPrivateEndpoint: true });
    try {
      await expect(
        assertSafeRemoteUrl(endpoint, resolve, { allowPrivateEndpoint: true }),
      ).rejects.toThrow(/private/);
      await expect(safeFetch(endpoint)).rejects.toThrow(/private/);
      expect(resolve).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await safeFetch.close();
    }
  });

  it("rejects a private-suffix hostname that resolves to link-local metadata", async () => {
    await expect(
      assertSafeRemoteUrl(
        "https://nas.local/mcp",
        async () => [{ address: "169.254.170.2", family: 4 as const }],
        { allowPrivateEndpoint: true },
      ),
    ).rejects.toThrow("private address");
  });

  it.each([
    "http://127.0.0.1:3100/api/auth/get-session",
    "http://localhost:3100/mcp",
    "http://[::1]:3100/mcp",
    "https://localhost:3100/mcp",
    "http://127.0.0.2:3100/mcp",
  ])("rejects loopback %s without the private-endpoint escape", async (endpoint) => {
    const resolve = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    await expect(assertSafeRemoteUrl(endpoint, resolve)).rejects.toThrow(/HTTPS|private/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("allows HTTP loopback with the private-endpoint escape", async () => {
    await expect(
      assertSafeRemoteUrl("http://127.0.0.1:3927/mcp", publicResolver, {
        allowPrivateEndpoint: true,
      }),
    ).resolves.toEqual(new URL("http://127.0.0.1:3927/mcp"));
  });

  it("rejects HTTP when a private-suffix hostname resolves publicly", async () => {
    await expect(
      assertSafeRemoteUrl("http://mcp.internal/mcp", publicResolver, {
        allowPrivateEndpoint: true,
      }),
    ).rejects.toThrow(/HTTPS/i);
  });

  it("rejects public HTTP even when the private-endpoint escape is enabled", async () => {
    await expect(
      assertSafeRemoteUrl("http://connectors.example.test/mcp", publicResolver, {
        allowPrivateEndpoint: true,
      }),
    ).rejects.toThrow(/HTTPS/i);
  });

  it("allows a hostname that resolves privately only when the escape is enabled", async () => {
    const lanResolver = async () => [{ address: "10.1.2.3", family: 4 as const }];
    await expect(assertSafeRemoteUrl("https://mcp.lan.test/mcp", lanResolver)).rejects.toThrow(
      "private address",
    );
    await expect(
      assertSafeRemoteUrl("https://mcp.lan.test/mcp", lanResolver, { allowPrivateEndpoint: true }),
    ).resolves.toEqual(new URL("https://mcp.lan.test/mcp"));
    await expect(
      assertSafeRemoteUrl("http://mcp.lan.test/mcp", lanResolver, { allowPrivateEndpoint: true }),
    ).resolves.toEqual(new URL("http://mcp.lan.test/mcp"));
  });

  it("accepts hosts that resolve to a public IPv6 address", async () => {
    await expect(
      assertSafeRemoteUrl("https://connectors.example.test/mcp", async () => [
        { address: "2606:4700:4700::1111", family: 6 as const },
      ]),
    ).resolves.toEqual(new URL("https://connectors.example.test/mcp"));
  });

  it.each([
    "http://connectors.example.test/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://user:password@connectors.example.test/mcp",
    "https://[::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
  ])("rejects unsafe endpoint %s", async (endpoint) => {
    await expect(assertSafeRemoteUrl(endpoint, publicResolver)).rejects.toThrow();
  });

  it("rejects a hostname that resolves privately", async () => {
    await expect(
      assertSafeRemoteUrl("https://connectors.example.test/mcp", async () => [
        { address: "10.1.2.3", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
  });

  it("rejects MagicDNS hosts for users without the private-endpoint escape", async () => {
    const magicDns = "https://box.tail12345.ts.net/openapi.json";
    await expect(
      assertSafeRemoteUrl(magicDns, async () => [{ address: "100.64.1.2", family: 4 as const }]),
    ).rejects.toThrow("private address");
    await expect(
      assertSafeRemoteUrl(
        magicDns,
        async () => [{ address: "fd7a:115c:a1e0:ab12:4843:cd96:6265:6667", family: 6 as const }],
        { allowPrivateEndpoint: false },
      ),
    ).rejects.toThrow("private address");

    const safeLookup = createSafeLookup(async () => [{ address: "100.119.57.55", family: 4 }]);
    const error = await new Promise<Error | null>((resolve) => {
      safeLookup("box.tail12345.ts.net", { family: 0, all: false }, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(error).toMatchObject({ message: "Connector URL resolves to a private address" });
  });

  it("allows both halves of a MagicDNS answer with the private-endpoint escape", async () => {
    // MagicDNS answers with the node's fd7a:115c:a1e0::/48 ULA alongside its
    // CGNAT address, so rejecting the ULA rejects every tailnet host.
    const magicDns = "https://box.tail12345.ts.net/mcp";
    const policy = { allowPrivateEndpoint: true };
    const addresses = [
      { address: "fd7a:115c:a1e0:ab12:4843:cd96:6265:6667", family: 6 as const },
      { address: "100.64.1.2", family: 4 as const },
    ];
    await expect(assertSafeRemoteUrl(magicDns, async () => addresses, policy)).resolves.toEqual(
      new URL(magicDns),
    );

    const safeLookup = createSafeLookup(async () => addresses, policy);
    const resolved = await new Promise<unknown>((resolve, reject) => {
      safeLookup("box.tail12345.ts.net", { family: 0, all: true }, (error, entries) => {
        if (error) reject(error);
        else resolve(entries);
      });
    });
    expect(resolved).toEqual(addresses);
  });

  it("rejects non-Tailscale IPv6 private ranges for MagicDNS hosts", async () => {
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/mcp", async () => [
        { address: "fd00:1234::1", family: 6 as const },
      ]),
    ).rejects.toThrow("private address");
  });

  it("still rejects raw Tailscale CGNAT IP literals", async () => {
    await expect(
      assertSafeRemoteUrl("https://100.64.1.2/openapi.json", publicResolver),
    ).rejects.toThrow(/private host/i);
  });

  it("rejects MagicDNS hosts that resolve outside Tailscale CGNAT", async () => {
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/openapi.json", async () => [
        { address: "127.0.0.1", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/openapi.json", async () => [
        { address: "10.1.2.3", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/openapi.json", async () => [
        { address: "169.254.169.254", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/openapi.json", async () => [
        { address: "100.100.100.200", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
  });

  it("rejects private addresses in the lookup used by the network connection", async () => {
    const safeLookup = createSafeLookup(async () => [{ address: "10.1.2.3", family: 4 }]);
    const error = await new Promise<Error | null>((resolve) => {
      safeLookup("connectors.example.test", { family: 0, all: false }, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(error).toMatchObject({ message: "Connector URL resolves to a private address" });
  });

  it("permits verified loopback addresses for localhost HTTP through the guarded Agent lookup", async () => {
    const loopbackResolver = async () => [{ address: "127.0.0.1", family: 4 as const }];
    const ownerPolicy = { allowPrivateEndpoint: true };
    const safeLookup = createSafeLookup(loopbackResolver, ownerPolicy);
    const result = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      safeLookup("localhost", { family: 0, all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family });
      });
    });
    expect(result).toEqual({ address: "127.0.0.1", family: 4 });

    const reboundLookup = createSafeLookup(
      async () => [{ address: "10.1.2.3", family: 4 }],
      ownerPolicy,
    );
    const reboundError = await new Promise<Error | null>((resolve) => {
      reboundLookup("localhost", { family: 0, all: false }, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(reboundError).toMatchObject({
      message: "Connector URL resolves to a private address",
    });

    const publicLoopbackLookup = createSafeLookup(loopbackResolver);
    const publicError = await new Promise<Error | null>((resolve) => {
      publicLoopbackLookup("connectors.example.test", { family: 0, all: false }, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(publicError).toMatchObject({
      message: "Connector URL resolves to a private address",
    });

    const nonOwnerError = await new Promise<Error | null>((resolve) => {
      publicLoopbackLookup("localhost", { family: 0, all: false }, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(nonOwnerError).toMatchObject({
      message: "Connector URL resolves to a private address",
    });

    expect(undiciFetch).not.toBe(globalThis.fetch);
    const safeFetch = createSafeRemoteFetch(undefined, loopbackResolver, ownerPolicy);
    try {
      const error = await safeFetch("http://localhost:59999/mcp").then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^Could not reach localhost:59999/);
      expect((error as Error).message).not.toMatch(/private address/);
    } finally {
      await safeFetch.close();
    }
  });

  it("returns the validated address directly to the network connection", async () => {
    const safeLookup = createSafeLookup(publicResolver);
    const result = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      safeLookup("connectors.example.test", { family: 0, all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family });
      });
    });
    expect(result).toEqual({ address: "203.0.113.10", family: 4 });
  });

  it("reports why a connection failed instead of a bare fetch failure", async () => {
    const cause = Object.assign(new Error("connect EHOSTUNREACH 100.64.1.2:443"), {
      code: "EHOSTUNREACH",
    });
    const safeFetch = createSafeRemoteFetch(async () => {
      throw new TypeError("fetch failed", { cause });
    }, publicResolver);
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow(
        "Could not reach connectors.example.test: connect EHOSTUNREACH 100.64.1.2:443",
      );
    } finally {
      await safeFetch.close();
    }
  });

  it("unwraps the per-address errors undici reports for dual-stack hosts", async () => {
    const safeFetch = createSafeRemoteFetch(async () => {
      throw new TypeError("fetch failed", {
        cause: new AggregateError(
          [new TypeError("fetch failed"), new Error("connect ECONNREFUSED 100.64.1.2:443")],
          "",
        ),
      });
    }, publicResolver);
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow(
        "connect ECONNREFUSED 100.64.1.2:443",
      );
    } finally {
      await safeFetch.close();
    }
  });

  it("drives the guarded dispatcher with a fetch from the same undici", async () => {
    // A fetch from a different undici than the Agent fails at dispatch before the lookup runs,
    // so failing inside the lookup proves the request reached the guarded Agent.
    expect(undiciFetch).not.toBe(globalThis.fetch);

    const capturedNodeFetch = globalThis.fetch;
    let resolutions = 0;
    const resolve = async () => {
      resolutions += 1;
      if (resolutions > 1) throw new Error("lookup reached");
      return [{ address: "203.0.113.10", family: 4 as const }];
    };
    for (const injected of [undefined, globalThis.fetch, capturedNodeFetch] as const) {
      resolutions = 0;
      const safeFetch = createSafeRemoteFetch(injected, resolve);
      try {
        await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow(
          "Could not reach connectors.example.test: lookup reached",
        );
      } finally {
        await safeFetch.close();
      }
    }
  });

  it("pairs a replaced global fetch with the package Agent", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
    let resolutions = 0;
    const resolve = async () => {
      resolutions += 1;
      if (resolutions > 1) throw new Error("lookup reached");
      return [{ address: "203.0.113.10", family: 4 as const }];
    };
    try {
      const safeFetch = createSafeRemoteFetch(globalThis.fetch, resolve);
      try {
        await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow(
          "Could not reach connectors.example.test: lookup reached",
        );
      } finally {
        await safeFetch.close();
      }
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("still pins lookup for a captured Node fetch after globalThis.fetch changes", async () => {
    const captured = globalThis.fetch;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
    let resolutions = 0;
    const resolve = async () => {
      resolutions += 1;
      if (resolutions > 1) throw new Error("lookup reached");
      return [{ address: "203.0.113.10", family: 4 as const }];
    };
    try {
      const safeFetch = createSafeRemoteFetch(captured, resolve);
      try {
        await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow(
          "Could not reach connectors.example.test: lookup reached",
        );
      } finally {
        await safeFetch.close();
      }
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("does not pass the package Agent to a wrapper around Node's fetch", async () => {
    // Wrappers are not === Node's fetch. Passing them the package Agent throws
    // invalid onRequestStart before lookup. Call them without dispatcher.
    let leakedDispatcher = false;
    let href: string | undefined;
    const wrapped: typeof globalThis.fetch = (input, init) => {
      leakedDispatcher = Boolean(init && "dispatcher" in init);
      href = String(input);
      return globalThis.fetch(input, init);
    };
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("stub fetch");
    }) as typeof globalThis.fetch;
    const safeFetch = createSafeRemoteFetch(wrapped, publicResolver);
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow("stub fetch");
      expect(leakedDispatcher).toBe(false);
      expect(href).toBe("https://connectors.example.test/mcp");
    } finally {
      globalThis.fetch = previous;
      await safeFetch.close();
    }
  });

  it("does not pass the package Agent to a mock fetch", async () => {
    let leakedDispatcher = false;
    const mock: typeof globalThis.fetch = async (_input, init) => {
      leakedDispatcher = Boolean(init && "dispatcher" in init);
      return new Response(null, { status: 204 });
    };
    const safeFetch = createSafeRemoteFetch(mock, publicResolver);
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).resolves.toMatchObject({
        status: 204,
      });
      expect(leakedDispatcher).toBe(false);
    } finally {
      await safeFetch.close();
    }
  });

  it("pins an injected fetch to the validated address so DNS cannot rebind", async () => {
    const seen: {
      href?: string;
      host?: string | null;
      leakedDispatcher?: boolean;
      lookup?: { address: string; family?: number };
    } = {};
    const injected: typeof globalThis.fetch = async (input, init) => {
      seen.href = String(input);
      seen.host = new Headers(init?.headers).get("host");
      seen.leakedDispatcher = Boolean(init && "dispatcher" in init);
      const hostname = new URL(String(input)).hostname.replace(/^\[|\]$/g, "");
      if (hostname === "127.0.0.1" || hostname === "203.0.113.10") {
        throw new Error(`injected fetch reached rebound host ${hostname}`);
      }
      seen.lookup = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
        dns.lookup(hostname, { family: 4 }, (error, address, family) => {
          if (error) reject(error);
          else resolve({ address: String(address), family });
        });
      });
      return new Response(null, { status: 204 });
    };
    const safeFetch = createSafeRemoteFetch(injected, publicResolver);
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).resolves.toMatchObject({
        status: 204,
      });
      expect(seen.leakedDispatcher).toBe(false);
      expect(seen.href).toBe("https://connectors.example.test/mcp");
      expect(seen.host).toBe("connectors.example.test");
      expect(seen.lookup).toEqual({ address: "203.0.113.10", family: 4 });
    } finally {
      await safeFetch.close();
    }
  });

  it("pins an injected fetch to a validated IPv6 address", async () => {
    const seen: {
      href?: string;
      host?: string | null;
      lookup?: { address: string; family?: number };
    } = {};
    const injected: typeof globalThis.fetch = async (input, init) => {
      seen.href = String(input);
      seen.host = new Headers(init?.headers).get("host");
      const hostname = new URL(String(input)).hostname.replace(/^\[|\]$/g, "");
      seen.lookup = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
        dns.lookup(hostname, { family: 6 }, (error, address, family) => {
          if (error) reject(error);
          else resolve({ address: String(address), family });
        });
      });
      return new Response(null, { status: 204 });
    };
    const safeFetch = createSafeRemoteFetch(injected, async () => [
      { address: "2606:4700:4700::1111", family: 6 as const },
    ]);
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).resolves.toMatchObject({
        status: 204,
      });
      expect(seen.href).toBe("https://connectors.example.test/mcp");
      expect(seen.host).toBe("connectors.example.test");
      expect(seen.lookup).toEqual({ address: "2606:4700:4700::1111", family: 6 });
    } finally {
      await safeFetch.close();
    }
  });

  it("rejects Request inputs instead of silently dropping their method and body", async () => {
    const safeFetch = createSafeRemoteFetch(
      async () => new Response(null, { status: 204 }),
      publicResolver,
    );
    try {
      await expect(
        safeFetch(
          new Request("https://connectors.example.test/mcp", {
            method: "POST",
            body: "payload",
          }),
        ),
      ).rejects.toThrow("requires a URL");
    } finally {
      await safeFetch.close();
    }
  });
});

describe("remote MCP tool result", () => {
  const initialize = (id: unknown) =>
    Response.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "test", version: "1" },
      },
    });

  /** Streamable HTTP peer answering one fixed tool result over an injected
   * fetch. A raw body string (with `$ID` for the request id) can carry JSON
   * number digits a JavaScript value cannot hold exactly. */
  function toolResultFetch(result: Record<string, unknown> | string) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as { id?: number; method?: string };
      if (message.method === "initialize") return initialize(message.id);
      if (message.method === "tools/call") {
        if (typeof result === "string")
          return new Response(result.replace("$ID", String(message.id)), {
            headers: { "content-type": "application/json" },
          });
        return Response.json({ jsonrpc: "2.0", id: message.id, result });
      }
      return new Response(null, { status: 202 });
    });
  }

  function callTool(fetch: ReturnType<typeof toolResultFetch>) {
    return callRemoteMcpTool(
      {
        endpoint: "https://mcp.example.test/mcp",
        fetch: fetch as unknown as typeof globalThis.fetch,
        resolveHostname: publicResolver,
      },
      "recall",
      {},
    );
  }

  it("fails a tool result body larger than the response limit before parsing it", async () => {
    const fetch = toolResultFetch(
      `{"jsonrpc":"2.0","id":$ID,"result":{"content":[{"type":"text","text":"${"x".repeat(MAX_MCP_RESPONSE_BYTES)}"}]}}`,
    );
    await expect(callTool(fetch)).rejects.toThrow("MCP server response exceeds 16 MB");
  });

  const memory = { results: [{ text: "first memory" }, { text: "second memory" }] };

  it("keeps one copy when a text block repeats structuredContent", async () => {
    const fetch = toolResultFetch({
      content: [{ type: "text", text: JSON.stringify(memory) }],
      structuredContent: memory,
    });
    await expect(callTool(fetch)).resolves.toEqual({
      content: [],
      structuredContent: memory,
      isError: false,
    });
  });

  it("drops a duplicate text block however the server formatted the JSON", async () => {
    const fetch = toolResultFetch({
      content: [{ type: "text", text: JSON.stringify(memory, null, 2) }],
      structuredContent: memory,
    });
    await expect(callTool(fetch)).resolves.toEqual({
      content: [],
      structuredContent: memory,
      isError: false,
    });
  });

  it("keeps both copies when the text is different data", async () => {
    const other = { results: [{ text: "different" }] };
    const fetch = toolResultFetch({
      content: [{ type: "text", text: JSON.stringify(other) }],
      structuredContent: memory,
    });
    await expect(callTool(fetch)).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify(other) }],
      structuredContent: memory,
      isError: false,
    });
  });

  it("keeps a text-only result unchanged", async () => {
    const fetch = toolResultFetch({ content: [{ type: "text", text: "plain answer" }] });
    await expect(callTool(fetch)).resolves.toEqual({
      content: [{ type: "text", text: "plain answer" }],
      isError: false,
    });
  });

  it("keeps a structured-only result unchanged", async () => {
    const fetch = toolResultFetch({ content: [], structuredContent: memory });
    await expect(callTool(fetch)).resolves.toEqual({
      content: [],
      structuredContent: memory,
      isError: false,
    });
  });

  it("keeps images and other text blocks, dropping only the duplicate text", async () => {
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    const fetch = toolResultFetch({
      content: [
        image,
        { type: "text", text: JSON.stringify(memory) },
        { type: "text", text: "a note beside the data" },
      ],
      structuredContent: memory,
    });
    await expect(callTool(fetch)).resolves.toEqual({
      content: [image, { type: "text", text: "a note beside the data" }],
      structuredContent: memory,
      isError: false,
    });
  });

  it("keeps both copies when the shared JSON holds an integer beyond the safe range", async () => {
    // Parsing rounds both copies of 9007199254740993 to 9007199254740992, so
    // they would compare deep-equal; only the text still carries the exact id.
    const exact = '{"id":9007199254740993}';
    const fetch = toolResultFetch(
      `{"jsonrpc":"2.0","id":$ID,"result":{"content":[{"type":"text","text":${JSON.stringify(
        exact,
      )}}],"structuredContent":{"id":9007199254740993}}}`,
    );
    await expect(callTool(fetch)).resolves.toEqual({
      content: [{ type: "text", text: exact }],
      structuredContent: { id: 9007199254740992 },
      isError: false,
    });
  });

  it.each([
    ["9.007199254740993e15", 9007199254740992],
    ["1.0000000000000001", 1],
  ])(
    "keeps both copies when the decimal %s cannot survive a JavaScript number",
    async (token, rounded) => {
      const exact = `{"id":${token}}`;
      const fetch = toolResultFetch(
        `{"jsonrpc":"2.0","id":$ID,"result":{"content":[{"type":"text","text":${JSON.stringify(
          exact,
        )}}],"structuredContent":{"id":${token}}}}`,
      );
      await expect(callTool(fetch)).resolves.toEqual({
        content: [{ type: "text", text: exact }],
        structuredContent: { id: rounded },
        isError: false,
      });
    },
  );

  it("still drops the duplicate when big digits appear only inside strings", async () => {
    const data = { note: "id 9007199254740993 in prose", count: 3 };
    const fetch = toolResultFetch({
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    });
    await expect(callTool(fetch)).resolves.toEqual({
      content: [],
      structuredContent: data,
      isError: false,
    });
  });

  it("keeps an error result's text, so audits report the specific failure", async () => {
    const failure = { error: { message: "Missing permission: updates" } };
    const fetch = toolResultFetch({
      content: [{ type: "text", text: JSON.stringify(failure) }],
      structuredContent: failure,
      isError: true,
    });
    const envelope = await callTool(fetch);
    expect(envelope).toEqual({
      content: [{ type: "text", text: JSON.stringify(failure) }],
      structuredContent: failure,
      isError: true,
    });
    const audit = toolCompletionAuditPayload({
      name: "recall",
      executionId: "exec-1",
      durationMs: 3,
      result: envelope,
    });
    expect(audit.outcome).toBe("error");
    expect(audit.error).toContain("Missing permission: updates");
  });
});

describe("remote MCP result limits", () => {
  it("applies the result budget in UTF-8 bytes instead of JavaScript characters", () => {
    const value = { content: "界".repeat(400_000) };
    const limited = limitRemoteMcpPayload(value) as { truncated: boolean; content: string };

    expect(limited.truncated).toBe(true);
    expect(Buffer.byteLength(limited.content, "utf8")).toBeLessThanOrEqual(1_000_000);
    expect(limited.content).not.toContain("\uFFFD");
  });
});

describe("createPrivateNetworkFetch", () => {
  const lanResolver = async () => [{ address: "192.168.2.10", family: 4 as const }];
  const mockFetch = () =>
    vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));

  it("delivers to a private HTTP destination", async () => {
    const baseFetch = mockFetch();
    const fetch = createPrivateNetworkFetch(baseFetch, lanResolver);
    const response = await fetch("http://192.168.2.10:8080/v1/items", { method: "GET" });
    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledOnce();
    expect(String(baseFetch.mock.calls[0]?.[0])).toBe("http://192.168.2.10:8080/v1/items");
  });

  it.each(["::ffff:169.254.170.2", "::ffff:a9fe:a9fe", "::ffff:a9fe:101"])(
    "rejects an opted-in host that resolves to the mapped link-local address %s",
    async (address) => {
      const baseFetch = mockFetch();
      const fetch = createPrivateNetworkFetch(baseFetch, async () => [{ address, family: 6 }]);
      await expect(fetch("http://nas.local:8080/v1/items", { method: "GET" })).rejects.toThrow(
        "non-private address",
      );
      expect(baseFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects an opted-in host that resolves to a public address", async () => {
    const baseFetch = mockFetch();
    const fetch = createPrivateNetworkFetch(baseFetch, publicResolver);
    await expect(fetch("http://nas.local:8080/v1/items", { method: "GET" })).rejects.toThrow(
      "non-private address",
    );
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("drives the guarded dispatcher with a fetch from the same undici", async () => {
    expect(undiciFetch).not.toBe(globalThis.fetch);
    const captured = globalThis.fetch;
    for (const injected of [undefined, globalThis.fetch, captured] as const) {
      let resolutions = 0;
      const safeFetch = createPrivateNetworkFetch(injected, async () => {
        resolutions += 1;
        if (resolutions > 1) throw new Error("lookup reached");
        return [{ address: "192.168.2.10", family: 4 as const }];
      });
      try {
        await expect(safeFetch("http://nas.local:8080/v1")).rejects.toThrow(/lookup reached/);
      } finally {
        await safeFetch.close();
      }
    }
  });

  it("rejects redirect responses instead of returning them", async () => {
    const baseFetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://10.9.9.9/exfil" } }),
    );
    const fetch = createPrivateNetworkFetch(baseFetch, lanResolver);
    await expect(fetch("http://192.168.2.10:8080/v1/items", { method: "GET" })).rejects.toThrow(
      "redirects are not allowed",
    );
  });

  it("releases a refused redirect body in both connector fetches so close() does not wait on it", async () => {
    // Larger than undici buffers, so an unread body holds the connection open.
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: "http://localhost/elsewhere" });
      response.end("x".repeat(1_000_000));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const loopbackResolver = async () => [{ address: "127.0.0.1", family: 4 as const }];
    try {
      for (const [fetch, refusal] of [
        [
          createSafeRemoteFetch(undefined, loopbackResolver, { allowPrivateEndpoint: true }),
          ConnectorRedirectError,
        ],
        [createPrivateNetworkFetch(undefined, loopbackResolver), "redirects are not allowed"],
      ] as const) {
        await expect(fetch(`http://localhost:${port}/mcp`)).rejects.toThrow(refusal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const closed = await Promise.race([
          fetch.close().then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 2_000);
          }),
        ]);
        clearTimeout(timer);
        expect(closed).toBe(true);
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("a guarded fetch that fails", () => {
  const coded = (code: string) => Object.assign(new Error(`failed ${code}`), { code });
  const failingWith = (cause: unknown) => async () => {
    throw new TypeError("fetch failed", { cause });
  };
  const fetchers = [
    ["public", (cause: unknown) => createSafeRemoteFetch(failingWith(cause), publicResolver)],
    [
      "private network",
      (cause: unknown) =>
        createPrivateNetworkFetch(failingWith(cause), async () => [
          { address: "192.168.2.10", family: 4 as const },
        ]),
    ],
  ] as const;
  const failure = async (
    create: (cause: unknown) => ReturnType<typeof createSafeRemoteFetch>,
    cause: unknown,
  ) => {
    const fetch = create(cause);
    try {
      return await fetch("https://connectors.example.test/mcp").then(
        () => null,
        (error: unknown) => error,
      );
    } finally {
      await fetch.close();
    }
  };

  // As Node reports them: the call that failed says whether the socket ever connected.
  const during = (syscall: string, code: string) =>
    Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
  // No connection was made, so nothing of the request, its credential included, left.
  const neverConnected = [
    during("connect", "ECONNREFUSED"),
    during("connect", "EHOSTUNREACH"),
    during("connect", "ENETUNREACH"),
    during("connect", "ECONNRESET"),
    during("connect", "ETIMEDOUT"),
    during("getaddrinfo", "ENOTFOUND"),
    coded("ENOTFOUND"),
    coded("EAI_AGAIN"),
    coded("UND_ERR_CONNECT_TIMEOUT"),
    // Verified during the handshake, before the request is written.
    coded("CERT_HAS_EXPIRED"),
    coded("DEPTH_ZERO_SELF_SIGNED_CERT"),
    coded("UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
    coded("ERR_TLS_CERT_ALTNAME_INVALID"),
    // Every address of a dual-stack host refused.
    new AggregateError([during("connect", "ECONNREFUSED"), during("connect", "ENETUNREACH")], ""),
  ];
  // Connected, or not known not to be: the request may have been written.
  const maybeSent = [
    coded("UND_ERR_HEADERS_TIMEOUT"),
    coded("UND_ERR_BODY_TIMEOUT"),
    coded("UND_ERR_SOCKET"),
    during("read", "ECONNRESET"),
    during("write", "EPIPE"),
    // An established connection that times out reports the unreachable error it last saw.
    during("read", "EHOSTUNREACH"),
    during("read", "ETIMEDOUT"),
    // Without the call that failed, these may have come after the connection.
    coded("ECONNREFUSED"),
    coded("EHOSTUNREACH"),
    coded("ECONNRESET"),
    coded("ETIMEDOUT"),
    // A bad TLS record may arrive once the session is up and the request written.
    coded("ERR_SSL_WRONG_VERSION_NUMBER"),
    coded("ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"),
    new DOMException("This operation was aborted", "AbortError"),
    new AggregateError([during("connect", "ECONNREFUSED"), during("read", "ECONNRESET")], ""),
    // Text alone is never trusted: a code is.
    new Error("connect ECONNREFUSED 203.0.113.10:443"),
    undefined,
  ];

  for (const [name, create] of fetchers) {
    it(`says no request left a ${name} fetch that never connected`, async () => {
      for (const cause of neverConnected) {
        const error = await failure(create, cause);
        expect(error, String((cause as { code?: string }).code)).toBeInstanceOf(Error);
        expect(error, String((cause as { code?: string }).code)).not.toBeInstanceOf(
          RemoteRequestSentError,
        );
        expect((error as Error).message).toMatch(/^Could not reach connectors\.example\.test/);
      }
    });

    it(`counts a ${name} fetch that may have sent its request as sent`, async () => {
      for (const cause of maybeSent) {
        const error = await failure(create, cause);
        expect(error, String((cause as { code?: string } | undefined)?.code)).toBeInstanceOf(
          RemoteRequestSentError,
        );
      }
    });
  }

  it("tells a refused connection from a request cut off, over real sockets", async () => {
    const owner = { allowPrivateEndpoint: true };
    const loopback = async () => [{ address: "127.0.0.1", family: 4 as const }];
    const listen = async (server: ReturnType<typeof createNetServer>) => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return (server.address() as AddressInfo).port;
    };
    const closed = createNetServer();
    const closedPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    // Reads the request, then resets the connection.
    const cutOff = createNetServer((socket) => socket.once("data", () => socket.resetAndDestroy()));
    const cutOffPort = await listen(cutOff);
    const fetch = createSafeRemoteFetch(undefined, loopback, owner);
    try {
      const refused = await fetch(`http://127.0.0.1:${closedPort}/mcp`).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(RemoteRequestSentError);
      const reset = await fetch(`http://127.0.0.1:${cutOffPort}/mcp`).catch((e: unknown) => e);
      expect(reset).toBeInstanceOf(RemoteRequestSentError);
    } finally {
      await fetch.close();
      await new Promise((resolve) => cutOff.close(resolve));
    }
  });
});
