import { CLIENT_IP_HEADER } from "@rakazo/auth";
import { recordSecurityEvent } from "@rakazo/db";
import {
  createLogger,
  createTestSink,
  getLogContext,
  getLogger,
  installLogger,
  runWithLogContext,
} from "@rakazo/logging";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  clientIpMiddleware,
  createClientIpResolver,
  defaultTrustedProxies,
  LOCAL_NETWORKS,
  requestClientIp,
  withClientIp,
} from "./client-ip.js";

const header = "x-forwarded-for";

describe("createClientIpResolver", () => {
  it("uses the socket peer and ignores the header when no proxy is trusted", async () => {
    const resolve = createClientIpResolver({ trustedProxies: [], header });
    expect(await resolve({ peer: "198.51.100.10", forwarded: "203.0.113.5" })).toBe(
      "198.51.100.10",
    );
  });

  it("ignores the header from a peer that is not a trusted proxy", async () => {
    const resolve = createClientIpResolver({ trustedProxies: ["172.20.0.0/16"], header });
    expect(await resolve({ peer: "198.51.100.10", forwarded: "203.0.113.5" })).toBe(
      "198.51.100.10",
    );
  });

  it("reads the header from a trusted proxy", async () => {
    const resolve = createClientIpResolver({ trustedProxies: ["172.20.0.0/16"], header });
    expect(await resolve({ peer: "::ffff:172.20.0.3", forwarded: "203.0.113.5" })).toBe(
      "203.0.113.5",
    );
  });

  it("walks the chain right to left, so a spoofed leftmost hop is never the answer", async () => {
    const resolve = createClientIpResolver({
      trustedProxies: ["172.20.0.3", "10.0.0.0/8"],
      header,
    });
    expect(
      await resolve({ peer: "172.20.0.3", forwarded: "192.0.2.66, 203.0.113.5, 10.1.2.3" }),
    ).toBe("203.0.113.5");
    expect(await resolve({ peer: "172.20.0.3", forwarded: "10.9.9.9, 10.1.2.3" })).toBe("10.9.9.9");
  });

  it("falls back to the peer for a malformed chain", async () => {
    const resolve = createClientIpResolver({ trustedProxies: ["172.20.0.3"], header });
    expect(await resolve({ peer: "172.20.0.3", forwarded: "203.0.113.5, not-an-ip" })).toBe(
      "172.20.0.3",
    );
  });

  it("accepts ports and brackets, and normalizes IPv6", async () => {
    const resolve = createClientIpResolver({ trustedProxies: ["fd00::/8"], header });
    expect(await resolve({ peer: "fd00::1", forwarded: "[2001:DB8::5]:443" })).toBe("2001:db8::5");
    expect(await resolve({ peer: "fd00::1", forwarded: "203.0.113.5:8443" })).toBe("203.0.113.5");
  });

  it("trusts a proxy named by hostname and re-resolves it after the cache expires", async () => {
    let now = 0;
    const lookup = vi.fn(async () => ["172.20.0.9"]);
    const resolve = createClientIpResolver(
      { trustedProxies: ["caddy"], header },
      { resolve: lookup, now: () => now },
    );
    expect(await resolve({ peer: "172.20.0.9", forwarded: "203.0.113.5" })).toBe("203.0.113.5");
    expect(await resolve({ peer: "172.20.0.4", forwarded: "203.0.113.5" })).toBe("172.20.0.4");
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 31_000;
    lookup.mockResolvedValueOnce(["172.20.0.4"]);
    expect(await resolve({ peer: "172.20.0.4", forwarded: "203.0.113.5" })).toBe("203.0.113.5");
  });

  it("keeps the last answer when a proxy hostname briefly fails to resolve", async () => {
    let now = 0;
    const lookup = vi.fn(async () => ["172.20.0.9"]);
    const resolve = createClientIpResolver(
      { trustedProxies: ["caddy"], header },
      { resolve: lookup, now: () => now },
    );
    await resolve({ peer: "172.20.0.9" });
    now = 31_000;
    lookup.mockRejectedValueOnce(new Error("EAI_AGAIN"));
    expect(await resolve({ peer: "172.20.0.9", forwarded: "203.0.113.5" })).toBe("203.0.113.5");
  });

  it("refreshes hostnames that still resolve when one lookup fails", async () => {
    let now = 0;
    const lookup = vi.fn(async (hostname: string) => {
      if (hostname === "edge" && now >= 31_000) throw new Error("EAI_AGAIN");
      if (hostname === "caddy") return now >= 31_000 ? ["172.20.0.4"] : ["172.20.0.9"];
      return ["172.20.0.8"];
    });
    const resolve = createClientIpResolver(
      { trustedProxies: ["caddy", "edge"], header },
      { resolve: lookup, now: () => now },
    );

    expect(await resolve({ peer: "172.20.0.9", forwarded: "203.0.113.5" })).toBe("203.0.113.5");
    expect(await resolve({ peer: "172.20.0.8", forwarded: "203.0.113.5" })).toBe("203.0.113.5");
    expect(lookup).toHaveBeenCalledTimes(2);

    now = 31_000;
    expect(await resolve({ peer: "172.20.0.4", forwarded: "203.0.113.5" })).toBe("203.0.113.5");
    expect(await resolve({ peer: "172.20.0.8", forwarded: "203.0.113.5" })).toBe("203.0.113.5");
    expect(lookup).toHaveBeenCalledTimes(4);

    now = 50_000;
    expect(await resolve({ peer: "172.20.0.4", forwarded: "198.51.100.7" })).toBe("198.51.100.7");
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("trusts the stack's own networks for local-networks, so a host proxy is believed", async () => {
    // The API's view inside Compose: loopback, the app network and the internal data network.
    const interfaces = () => ({
      lo: [{ cidr: "127.0.0.1/8" }, { cidr: "::1/128" }],
      eth0: [{ cidr: "192.168.172.3/24" }],
      eth1: [{ cidr: "172.31.0.4/24" }, { cidr: "fe80::1%eth1/64" }],
    });
    const resolve = createClientIpResolver(
      { trustedProxies: [LOCAL_NETWORKS], header },
      { interfaces: interfaces as never },
    );
    // Host proxy -> network gateway -> web container -> API.
    expect(await resolve({ peer: "192.168.172.4", forwarded: "203.0.113.5, 192.168.172.1" })).toBe(
      "203.0.113.5",
    );
    // A bot computer reaching the web proxy from its own network cannot pick an address.
    expect(await resolve({ peer: "192.168.172.4", forwarded: "198.51.100.1, 192.168.181.2" })).toBe(
      "192.168.181.2",
    );
    expect(await resolve({ peer: "203.0.113.9", forwarded: "198.51.100.1" })).toBe("203.0.113.9");
  });

  it("defaults to local networks only in a container, so a host's LAN is never trusted", () => {
    expect(defaultTrustedProxies(true)).toEqual([LOCAL_NETWORKS]);
    expect(defaultTrustedProxies(false)).toEqual(["127.0.0.1", "::1"]);
  });

  it("trusts no proxy for none", async () => {
    const resolve = createClientIpResolver(
      { trustedProxies: ["none"], header },
      { resolve: async () => ["127.0.0.1"] },
    );
    expect(await resolve({ peer: "127.0.0.1", forwarded: "203.0.113.5" })).toBe("127.0.0.1");
  });

  it("returns nothing without a socket peer, whatever the header says", async () => {
    const resolve = createClientIpResolver({ trustedProxies: ["0.0.0.0/0"], header });
    expect(await resolve({ forwarded: "203.0.113.5" })).toBeUndefined();
  });

  it.each(["10.0.0.0/33", "10.0.0.0/8/1", "not a host", "10.0.0.0/x"])(
    "rejects the invalid entry %s at startup",
    (entry) => {
      expect(() => createClientIpResolver({ trustedProxies: [entry], header })).toThrow(
        /TRUSTED_PROXIES/,
      );
    },
  );
});

describe("clientIpMiddleware", () => {
  function app(trustedProxies: string[]) {
    const hono = new Hono();
    hono.use("*", clientIpMiddleware(createClientIpResolver({ trustedProxies, header }), header));
    hono.get("/", async (c) => {
      getLogger().info("http.request.completed");
      await recordSecurityEvent({ type: "auth.sign_out" });
      return c.json({ ip: requestClientIp(c) ?? null, context: getLogContext() });
    });
    return hono;
  }
  const fromSocket = (hono: Hono, remoteAddress: string, headers: Record<string, string>) =>
    runWithLogContext({}, async () => {
      const response = await hono.fetch(new Request("http://api.test/", { headers }), {
        incoming: { socket: { remoteAddress } },
      });
      return (await response.json()) as { ip: string | null; context: Record<string, unknown> };
    });

  it("keeps caller details on security events only", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const body = await fromSocket(app(["192.0.2.3"]), "192.0.2.3", {
      [header]: "203.0.113.5",
      "user-agent": "curl/8.5.0",
    });
    expect(body.ip).toBe("203.0.113.5");
    expect(body.context).not.toHaveProperty("client.ip");
    expect(body.context).not.toHaveProperty("user_agent.original");
    const requestLog = sink.events.find((event) => event.message === "http.request.completed");
    expect(requestLog).toMatchObject({ message: "http.request.completed" });
    expect(requestLog).not.toHaveProperty("client.ip");
    expect(requestLog).not.toHaveProperty("user_agent.original");
    expect(sink.events.find((event) => event.message === "security.event")).toMatchObject({
      "client.ip": "203.0.113.5",
      "user_agent.original": "curl/8.5.0",
    });
  });

  it("does not let a direct caller choose its address", async () => {
    const body = await fromSocket(app([]), "198.51.100.10", { [header]: "203.0.113.5" });
    expect(body.ip).toBe("198.51.100.10");
  });
});

describe("withClientIp", () => {
  it("replaces a client-supplied copy of the auth IP header", () => {
    const request = new Request("http://api.test/api/auth/sign-in/email", {
      headers: { [CLIENT_IP_HEADER]: "192.0.2.66" },
    });
    expect(withClientIp(request, "203.0.113.5").headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.5");
    expect(withClientIp(request, undefined).headers.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("keeps the body of a POST", async () => {
    const request = new Request("http://api.test/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "user@example.test" }),
      headers: { "content-type": "application/json" },
    });
    expect(await withClientIp(request, "203.0.113.5").json()).toEqual({
      email: "user@example.test",
    });
  });
});
