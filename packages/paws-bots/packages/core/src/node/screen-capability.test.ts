import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ScreenCapabilityScope } from "./screen-capability.js";
import {
  issueScreenCapability,
  openScreenCapability,
  REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS,
  SCREEN_PROXY_TTL_MS,
  sealScreenCapability,
} from "./screen-capability.js";

const scope: ScreenCapabilityScope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 2,
  computerGeneration: 3,
  controlLeaseId: null,
};
const path = (url: string, interactive = false) =>
  new URL(
    sealScreenCapability(
      `${url}?token=fake-provider-token&view_only=${!interactive}`,
      "fake-secret",
      "https://app.example",
      scope,
      100,
    ),
  ).pathname;
describe("sealed screen capabilities", () => {
  it("seals provider credentials for page, asset, and websocket requests", () => {
    const upstream = "https://screen.example/vnc.html?path=websockify%3Ftoken%3Dfake-socket";
    const headers = { cookie: "provider_auth=fake-private-token" };
    const url = new URL(
      sealScreenCapability(upstream, "secret", "https://app.example", scope, 100, headers),
    );
    expect(url.toString()).not.toContain("fake-private-token");
    for (const resource of ["vnc.html", "app/ui.js", "websockify"]) {
      const opened = openScreenCapability(
        url.pathname.replace("vnc.html", resource),
        "secret",
        101,
      );
      expect(opened?.target.headers).toEqual(headers);
      expect(opened?.target.path).toContain(
        resource === "websockify" ? "token=fake-socket" : resource,
      );
      expect(
        openScreenCapability(url.pathname.replace("vnc.html", resource), "wrong", 101),
      ).toBeNull();
    }
  });
  it("includes provider credentials in the remote capability identity", () => {
    const issue = (cookie: string) =>
      issueScreenCapability(
        "https://screen.example/vnc.html",
        "secret",
        "https://app.example",
        scope,
        100,
        { cookie },
      );
    expect(issue("first")).toBe(issue("first"));
    expect(issue("second")).not.toBe(issue("first"));
  });
  it.each<Record<string, string>>([
    { cookie: "fake\r\nInjected: value" },
    { host: "other.example" },
    { connection: "upgrade" },
  ])("rejects unsafe upstream headers %j", (headers) => {
    expect(() =>
      sealScreenCapability(
        "https://screen.example/vnc.html",
        "secret",
        "https://app.example",
        scope,
        100,
        headers,
      ),
    ).toThrow("Invalid screen authentication headers");
  });

  it.each([false, true])(
    "connects the shipped embed through one capability prefix (control=%s)",
    (interactive) => {
      const provider = new URL("http://127.0.0.1:49152/embed.html");
      provider.searchParams.set("view_only", String(!interactive));
      provider.searchParams.set("path", "websockify?token=fake-socket-token");
      const url = new URL(
        sealScreenCapability(provider.toString(), "fake-secret", "https://app.example", scope, 100),
      );
      const html = readFileSync(
        new URL("../../../../infra/sandboxes/computer/embed.html", import.meta.url),
        "utf8",
      );
      const script = html
        .match(/<script type="module">([\s\S]*?)<\/script>/)![1]!
        .replace(/^\s*import[\s\S]*?;\s*$/gm, "");
      let socketUrl = "";
      const rootClasses = new Set<string>();
      const rootAttributes = new Map<string, string>();
      const rfbListeners = new Map<string, (event: { detail?: Record<string, unknown> }) => void>();
      runInNewContext(script, {
        document: {
          location: url,
          getElementById: () => ({}),
          documentElement: {
            classList: {
              add: (...names: string[]) => {
                for (const name of names) rootClasses.add(name);
              },
              remove: (...names: string[]) => {
                for (const name of names) rootClasses.delete(name);
              },
            },
            setAttribute: (name: string, value: string) => rootAttributes.set(name, value),
            hasAttribute: (name: string) => rootAttributes.has(name),
          },
        },
        window: { location: url },
        RFB: class {
          constructor(_element: unknown, value: string) {
            socketUrl = value;
          }
          addEventListener(
            type: string,
            listener: (event: { detail?: Record<string, unknown> }) => void,
          ) {
            rfbListeners.set(type, listener);
          }
        },
        attachHostClipboardPaste: () => {},
        attachMobilePaste: () => {},
        attachRemoteClipboardCopy: () => {},
        pasteHostText: () => false,
        // Embed imports are stripped for this smoke; stub the touch-keyboard
        // and trackpad bridges the same way as clipboard. Returning false
        // skips Keyboard / KeyTable / keysyms, which this harness does not provide.
        isTouchBrowser: () => false,
        attachMobileKeyboard: () => {},
        attachMobileTrackpad: () => {},
      });
      // The page shim reports these classes to the app, as it does for stock noVNC.
      expect([...rootClasses]).toEqual(["noVNC_connecting"]);
      rfbListeners.get("connect")?.({});
      expect([...rootClasses]).toEqual(["noVNC_connected"]);
      rfbListeners.get("disconnect")?.({ detail: { clean: false } });
      expect([...rootClasses]).toEqual([]);
      expect(rootAttributes.get("data-rakazo-screen-error")).toBe("");
      const socket = new URL(socketUrl);
      expect(socket.protocol).toBe("wss:");
      expect(socket.host).toBe(url.host);
      expect(socket.pathname).toBe(url.pathname.replace("/embed.html", "/websockify"));
      expect(socketUrl).not.toContain("fake-socket-token");
      expect(openScreenCapability(socket.pathname, "fake-secret", 101)?.target).toMatchObject({
        path: "/websockify?token=fake-socket-token",
        interactive,
      });
    },
  );
  it("hides provider credentials and binds scope and destination", () => {
    const value = path("https://screen.example/vnc.html");
    expect(value).not.toContain("fake-provider-token");
    expect(openScreenCapability(value, "fake-secret", 101)).toMatchObject({
      scope,
      target: {
        hostname: "screen.example",
        port: 443,
        protocol: "https:",
        interactive: false,
        path: "/vnc.html?token=fake-provider-token&view_only=true",
      },
    });
    expect(
      openScreenCapability(value.replace("/vnc.html", "/websockify"), "fake-secret", 101)?.target
        .path,
    ).toBe("/websockify?token=fake-provider-token&view_only=true");
  });
  it("keeps noVNC routing public and nested provider socket credentials sealed", () => {
    const provider = new URL("https://screen.example/vnc.html");
    provider.searchParams.set("path", "websockify?token=fake-socket-token");
    const url = new URL(
      sealScreenCapability(provider.toString(), "fake-secret", "https://app.example", scope, 100),
    );
    expect(url.toString()).not.toContain("fake-socket-token");
    expect(url.searchParams.get("autoconnect")).toBe("true");
    const socket = new URL(url.searchParams.get("path")!, url);
    expect(socket.pathname).toBe(url.pathname.replace("/vnc.html", "/websockify"));
    expect(new URL(url.searchParams.get("path")!, url.origin).pathname).toBe(socket.pathname);
    expect(openScreenCapability(socket.pathname, "fake-secret", 101)?.target.path).toBe(
      "/websockify?token=fake-socket-token",
    );
  });

  it("randomizes issuance even at the same timestamp", () => {
    expect(path("http://127.0.0.1:49152/embed.html")).not.toBe(
      path("http://127.0.0.1:49152/embed.html"),
    );
  });
  it("rejects wrong keys, modified policy, expiry and ciphertext", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    expect(openScreenCapability(value, "wrong", 101)).toBeNull();
    expect(
      openScreenCapability(value.replace("/view/", "/control/"), "fake-secret", 101),
    ).toBeNull();
    expect(
      openScreenCapability(value.replace("3600100.", "3600101."), "fake-secret", 101),
    ).toBeNull();
    expect(
      openScreenCapability(
        value.replace(/\.(.)/, (_, c) => `.${c === "a" ? "b" : "a"}`),
        "fake-secret",
        101,
      ),
    ).toBeNull();
    expect(openScreenCapability(value, "fake-secret", 100 + SCREEN_PROXY_TTL_MS)).toBeNull();
  });
  it("rejects truncated capability tokens before decryption", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    const match = value.match(/^(\/novnc\/session\/view\/\d+\.)([A-Za-z0-9_-]+)(\/.*)$/);
    expect(match).not.toBeNull();
    const truncated = `${match![1]}${match![2]!.slice(0, 8)}${match![3]}`;
    expect(openScreenCapability(truncated, "fake-secret", 101)).toBeNull();
  });
  it("enforces view policy and still serves relative assets", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    expect(
      openScreenCapability(`${value}?view_only=false`, "fake-secret", 101)?.target.path,
    ).toContain("view_only=true");
    expect(
      openScreenCapability(value.replace("/embed.html", "/core/rfb.js"), "fake-secret", 101)?.target
        .path,
    ).toBe("/core/rfb.js");
    expect(
      openScreenCapability(path("http://127.0.0.1:49152/embed.html", true), "fake-secret", 101)
        ?.target.interactive,
    ).toBe(true);
  });
  it.each(["http://public.example:49152/embed.html", "http://127.0.0.1:80/embed.html"])(
    "rejects disallowed local target %s",
    (url) => {
      expect(openScreenCapability(path(url), "fake-secret", 101)).toBeNull();
    },
  );
  it.each(["::1", "fc00::1", "fd50::8"])("allows private IPv6 screen sockets (%s)", (host) => {
    expect(
      openScreenCapability(path(`http://[${host}]:6100/embed.html`), "fake-secret", 101)?.target
        .hostname,
    ).toBe(host);
  });
  it.each(["2001:db8::1", "fe80::1", "::ffff:127.0.0.1", "::", "fc::1", "fd00:ec2::254"])(
    "rejects other IPv6 HTTP screen targets (%s)",
    (host) => {
      expect(
        openScreenCapability(path(`http://[${host}]:6100/embed.html`), "fake-secret", 101),
      ).toBeNull();
    },
  );
  it.each(["http://100.64.0.1:49152/embed.html", "http://100.127.255.254:49152/embed.html"])(
    "allows CGNAT 100.64/10 screen targets %s",
    (url) => {
      expect(openScreenCapability(path(url), "fake-secret", 101)?.target.hostname).toBe(
        new URL(url).hostname,
      );
    },
  );
  it.each([
    "http://100.63.255.255:49152/embed.html",
    "http://100.128.0.1:49152/embed.html",
    "http://100.100.100.200:49152/embed.html",
    "http://169.254.169.254:49152/embed.html",
    "http://0.0.0.0:49152/embed.html",
  ])("rejects addresses outside the private network, and metadata inside it %s", (url) => {
    expect(openScreenCapability(path(url), "fake-secret", 101)).toBeNull();
  });
});

describe("remote screen capability reuse", () => {
  const upstream =
    "https://6100-sandbox.example/vnc.html?autoconnect=true&resize=scale&path=websockify%3Ftoken%3Dview-1&view_only=true";
  const issued = (now: number, nextScope = scope, url = upstream, secret = "fake-secret") =>
    issueScreenCapability(url, secret, "https://app.example", nextScope, now);

  it("reuses one remote seal across polls that a slow handshake can still be using", () => {
    const now = 1_000_000;
    const first = issued(now);
    const duringHandshake = issued(now + 5_000);
    expect(duringHandshake).toBe(first);
    const opened = openScreenCapability(new URL(first).pathname, "fake-secret", now + 5_000);
    expect(opened?.target.path).toBe(
      "/vnc.html?autoconnect=true&resize=scale&path=websockify%3Ftoken%3Dview-1&view_only=true",
    );
    expect(
      openScreenCapability(
        new URL(first).pathname.replace("/vnc.html", "/websockify"),
        "fake-secret",
        now + 5_000,
      )?.target.path,
    ).toBe("/websockify?token=view-1");
    expect(
      openScreenCapability(new URL(first).pathname, "fake-secret", now + SCREEN_PROXY_TTL_MS),
    ).toBeNull();
  });

  it("gives a later read on another server the same seal and expiry", () => {
    const now = 1_000_000;
    const first = issued(now);
    const later = issued(now + 20 * 60_000);
    expect(later).toBe(first);
    const expiresAt = Number(new URL(later).pathname.match(/\/(\d+)\./)?.[1]);
    expect(expiresAt - now).toBeLessThanOrEqual(SCREEN_PROXY_TTL_MS);
    expect(expiresAt - (now + 20 * 60_000)).toBeGreaterThan(
      REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS,
    );
  });

  it("mints again before the held seal has less than the minimum left, without extending it", () => {
    const now = 1_000_000;
    const first = issued(now);
    const expiresAt = Number(new URL(first).pathname.match(/\/(\d+)\./)?.[1]);
    const refreshAt = expiresAt - REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS;
    expect(issued(refreshAt - 1)).toBe(first);
    const renewed = issued(refreshAt);
    expect(renewed).not.toBe(first);
    expect(openScreenCapability(new URL(first).pathname, "fake-secret", refreshAt)).not.toBeNull();
    expect(openScreenCapability(new URL(first).pathname, "fake-secret", expiresAt)).toBeNull();
    expect(
      openScreenCapability(new URL(renewed).pathname, "fake-secret", refreshAt),
    ).not.toBeNull();
    expect(
      openScreenCapability(
        new URL(renewed).pathname,
        "fake-secret",
        refreshAt + SCREEN_PROXY_TTL_MS,
      ),
    ).toBeNull();
  });

  it("rotates when the upstream token, scope, secret, or origin changes", () => {
    const now = 1_000_000;
    const first = issued(now);
    expect(issued(now + 1, scope, upstream.replace("view-1", "view-2"))).not.toBe(first);
    expect(
      issued(now + 1, { ...scope, computerGeneration: scope.computerGeneration + 1 }),
    ).not.toBe(first);
    expect(issued(now + 1, { ...scope, controlLeaseId: "lease" })).not.toBe(first);
    expect(issued(now + 1, scope, upstream, "other-secret")).not.toBe(first);
    expect(
      issueScreenCapability(upstream, "fake-secret", "https://other.example", scope, now + 1),
    ).not.toBe(first);
  });

  it("keeps minting a fresh capability for loopback screens", () => {
    const local = "http://127.0.0.1:49152/embed.html?path=websockify%3Ftoken%3Dview-1";
    expect(issued(1_000_000, scope, local)).not.toBe(issued(1_000_001, scope, local));
  });
});
