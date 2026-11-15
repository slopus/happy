import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo, Server as NetServer } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import {
  addScreenProxyCapability,
  openScreenCapability,
} from "@rakazo/core/node/screen-capability";
import { screenProbeUrl } from "@rakazo/core/screen-reconnect";
import type { Plugin, ViteDevServer } from "vite";
import { createServer, preview } from "vite";

const scope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 0,
  computerGeneration: 0,
  controlLeaseId: null,
};
const secret = "fake-screen-proxy-browser-test-secret";
const providerHeaders = { cookie: "provider_auth=fake-provider-credential" };
const screenHtml = `<!doctype html><title>Fake screen</title>
<script type="module">
  import { loaded } from './core/rfb.js';
  const attempt = (read) => { try { return read(); } catch { return 'blocked'; } };
  const result = {
    asset: loaded,
    cookie: attempt(() => document.cookie),
    storage: attempt(() => localStorage.getItem('app-data')),
    session: attempt(() => { sessionStorage.setItem('k', 'v'); return sessionStorage.getItem('k'); }),
    webcodecs: 'VideoDecoder' in window,
    // A blank child frame shares this opaque origin but not the shim, so it reaches the real
    // getter. Only a SecurityError proves the sandbox blocked it.
    realStorage: (() => {
      const frame = document.createElement('iframe');
      document.documentElement.append(frame);
      try {
        frame.contentWindow.localStorage;
        return 'readable';
      } catch (error) {
        return error.name;
      } finally {
        frame.remove();
      }
    })(),
    parent: attempt(() => parent.document.title),
    api: await fetch('/session', { credentials: 'include' }).then(r => r.text()).catch(() => 'blocked'),
  };
  const socketUrl = new URL('./websockify', location.href);
  socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketUrl);
  socket.onmessage = (event) => {
    result.socket = event.data;
    socket.close();
    document.body.textContent = JSON.stringify(result);
  };
</script><body></body>`;

async function listen(server: NetServer) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function sendUpgrade(url: URL) {
  const client = connect(Number(url.port), url.hostname);
  client.on("error", () => {});
  client.write(
    `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  return client;
}

// Resets a raw upgrade once the server has it, and resolves after the server saw the reset.
async function resetDuringUpgrade(server: Server, url: URL, beforeReset?: Promise<unknown>) {
  const received = new Promise<Duplex>((resolve) =>
    server.once("upgrade", (_req, socket) => resolve(socket)),
  );
  const client = sendUpgrade(url);
  const socket = await received;
  await beforeReset;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  client.resetAndDestroy();
  await closed;
}

for (const mode of ["development", "preview"] as const) {
  test.describe(`screen response isolation in ${mode}`, () => {
    let origin: string;
    let screenUrl: string;
    let otherPageUrl: string;
    let stop: () => Promise<void>;
    let httpServer: Server;

    let authorized = true;
    let assetAttempts = 0;
    let upstreamRequests = 0;
    let upstreamUpgraded: ((path: string) => void) | undefined;
    let authorityReached: (() => void) | undefined;
    let authorityHold: Promise<void> | undefined;
    test.beforeAll(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-screen-test-"));
      await mkdir(path.join(root, "dist"));
      const upstream = createHttpServer((req, res) => {
        upstreamRequests += 1;
        if (req.headers.cookie !== providerHeaders.cookie) {
          res.writeHead(403).end("Provider authentication required");
          return;
        }
        // Even a listener explicitly requesting same-origin access cannot loosen the proxy policy.
        res.setHeader(
          "Content-Security-Policy",
          `sandbox allow-scripts allow-same-origin allow-pointer-lock; frame-ancestors ${origin}`,
        );
        res.setHeader("Set-Cookie", "app-session=attacker; Path=/");
        if (req.url === "/core/rfb.js") {
          if (assetAttempts++ === 0) {
            res.destroy();
            return;
          }
          res.setHeader("Content-Type", "text/javascript");
          res.end('export const loaded = "module loaded";');
        } else if (req.headers["if-modified-since"] || req.headers["if-none-match"]) {
          // Like a static file server: a browser holding any copy gets 304 and keeps it.
          res.writeHead(304).end();
        } else if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
          // Like a provider edge: compress HTML whenever the client allows it.
          res.setHeader("Content-Type", "text/html");
          res.setHeader("Content-Encoding", "gzip");
          res.end(gzipSync(screenHtml));
        } else {
          res.setHeader("Content-Type", "text/html");
          res.end(screenHtml);
        }
      });
      upstream.on("upgrade", (req, socket) => {
        upstreamUpgraded?.(new URL(req.url ?? "/", "http://upstream").pathname);
        if (req.headers.cookie !== providerHeaders.cookie) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        const accept = createHash("sha1")
          .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: app-session=attacker; Path=/\r\n\r\n`,
        );
        socket.write(Buffer.from([0x81, 2, 111, 107]));
        socket.on("data", () => socket.end(Buffer.from([0x88, 0])));
        socket.on("error", () => socket.destroy());
        socket.on("end", () => socket.destroy());
      });
      const upstreamOrigin = await listen(upstream);

      const appFixture: Plugin = {
        name: "fake-app-origin",
        configureServer: installApp,
        configurePreviewServer: installApp,
      };
      function installApp(server: Pick<ViteDevServer, "middlewares">) {
        server.middlewares.use((req, res, next) => {
          // A script file, not inline: in preview the app's CSP applies to this page too.
          if (req.url === "/app") {
            res.setHeader("Content-Type", "text/html");
            res.end(
              '<!doctype html><title>Fake app</title><body><script src="/app.js"></script></body>',
            );
          } else if (req.url === "/app.js") {
            res.setHeader("Content-Type", "text/javascript");
            res.end(
              'localStorage.setItem("app-data", "private-app-data"); document.cookie = "app-session=fake-session; Path=/";',
            );
          } else if (req.url === "/session") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
          } else next();
        });
      }
      const authority = createHttpServer(async (req, res) => {
        authorityReached?.();
        await authorityHold;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const capability = openScreenCapability(body.path, secret);
        if (!authorized || !capability || req.headers.authorization !== `Bearer ${secret}`) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(capability.target));
      });
      const previousApi = process.env.API_PROXY_TARGET;
      process.env.API_PROXY_TARGET = await listen(authority);
      const previousSecret = process.env.SCREEN_PROXY_SECRET;
      process.env.SCREEN_PROXY_SECRET = secret;
      try {
        // Load the real configuration: both production and development hooks must install the policy.
        const config = {
          root,
          configFile: path.resolve(import.meta.dirname, "../vite.config.ts"),
          mode: "test",
          plugins: [appFixture],
          logLevel: "silent" as const,
          server: { host: "127.0.0.1", port: 0, hmr: false as const },
          preview: { host: "127.0.0.1", port: 0 },
        };
        const server = mode === "development" ? await createServer(config) : await preview(config);
        // listen() replaces zero with Vite's default port; bind the HTTP server directly instead.
        httpServer = server.httpServer as Server;
        if ("listen" in server) await listen(httpServer);
        origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
        // Exercise the same capability issuer used by the production API, with a configured web origin.
        // A loopback upstream serving /vnc.html stands in for E2B, Daytona, Boat and Railway.
        screenUrl = addScreenProxyCapability(
          `${upstreamOrigin}/vnc.html`,
          secret,
          origin,
          scope,
          undefined,
          providerHeaders,
        );
        otherPageUrl = addScreenProxyCapability(
          `${upstreamOrigin}/other.html`,
          secret,
          origin,
          scope,
          undefined,
          providerHeaders,
        );
        stop = async () => {
          await server.close();
          await close(upstream);
          await close(authority);
          await rm(root, { recursive: true, force: true });
        };
      } finally {
        if (previousApi === undefined) delete process.env.API_PROXY_TARGET;
        else process.env.API_PROXY_TARGET = previousApi;
        if (previousSecret === undefined) delete process.env.SCREEN_PROXY_SECRET;
        else process.env.SCREEN_PROXY_SECRET = previousSecret;
      }
    });

    test.afterAll(async () => {
      await stop?.();
    });

    test("direct navigation cannot read application data while assets and WebSockets work", async ({
      page,
    }) => {
      await page.goto(`${origin}/app`);
      const response = await page.goto(screenUrl);
      await expect(page.locator("body")).toContainText('"socket":"ok"');
      expect(assetAttempts).toBeGreaterThanOrEqual(2);
      const result = JSON.parse(await page.locator("body").innerText());
      expect(await page.context().cookies(origin)).not.toContainEqual(
        expect.objectContaining({ name: "provider_auth" }),
      );
      expect(result).toMatchObject({
        asset: "module loaded",
        socket: "ok",
        cookie: "blocked",
        storage: null,
        session: "v",
        webcodecs: false,
        realStorage: "SecurityError",
        api: "blocked",
      });
      expect(response?.headers()["content-security-policy"]).toContain(
        "sandbox allow-scripts allow-pointer-lock",
      );
      expect(
        (await page.context().cookies(origin)).find((c) => c.name === "app-session")?.value,
      ).toBe("fake-session");
    });

    test("a browser holding an old copy still gets the rewritten page, never stored", async ({
      request,
    }) => {
      const response = await request.get(screenUrl, {
        headers: {
          "if-modified-since": "Wed, 21 Oct 2026 01:05:20 GMT",
          "if-none-match": '"cached"',
        },
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("no-store, no-transform");
      expect(response.headers()["last-modified"]).toBeUndefined();
      expect(await response.text()).toContain("const items = new Map()");
    });

    test("a status-only probe is answered after the access check and never reaches the computer", async ({
      request,
    }) => {
      const before = upstreamRequests;
      const allowed = await request.get(screenProbeUrl(screenUrl), { maxRedirects: 0 });
      expect(allowed.status()).toBe(204);
      expect(allowed.headers()["cache-control"]).toBe("no-store");
      expect(await allowed.body()).toHaveLength(0);
      authorized = false;
      try {
        const refused = await request.get(screenProbeUrl(screenUrl), { maxRedirects: 0 });
        expect(refused.status()).toBe(403);
        expect(await refused.body()).toHaveLength(0);
      } finally {
        authorized = true;
      }
      expect(upstreamRequests).toBe(before);
    });

    test("a client that resets during the access check does not stop the server", async ({
      request,
    }) => {
      // Vite's dev WebSocket server already ignores client socket errors; preview does not.
      test.skip(mode === "development");
      let release = () => {};
      authorityHold = new Promise((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        authorityReached = resolve;
      });
      const upgrades: string[] = [];
      const held = new Promise<void>((resolve) => {
        upstreamUpgraded = (path) => {
          upgrades.push(path);
          if (path === "/hold") resolve();
        };
      });
      try {
        const target = new URL(screenUrl);
        target.pathname = target.pathname.replace("/vnc.html", "/websockify");
        try {
          await resetDuringUpgrade(httpServer, target, reached);
        } finally {
          authorityReached = undefined;
          authorityHold = undefined;
          release();
        }
        // Its access check is answered after the reset one, so once it reaches the computer the
        // reset connection's check has finished too.
        target.pathname = target.pathname.replace("/websockify", "/hold");
        const next = sendUpgrade(target);
        await held;
        next.destroy();
      } finally {
        upstreamUpgraded = undefined;
      }
      expect(upgrades).toEqual(["/hold"]);
      expect((await request.get(`${origin}/app`)).status()).toBe(200);
    });

    test("an upgrade to a non-screen path that resets does not stop the server", async ({
      request,
    }) => {
      test.skip(mode === "development");
      await resetDuringUpgrade(httpServer, new URL(`${origin}/somewhere`));
      expect((await request.get(`${origin}/app`)).status()).toBe(200);
    });

    test("HTML that is not a noVNC page is passed through unchanged", async ({ page }) => {
      await page.goto(`${origin}/app`);
      const response = await page.goto(otherPageUrl);
      await expect(page.locator("body")).toContainText('"socket":"ok"');
      expect(response?.headers()["content-encoding"]).toBe("gzip");
      expect(JSON.parse(await page.locator("body").innerText())).toMatchObject({
        storage: "blocked",
        session: "blocked",
        webcodecs: true,
        realStorage: "SecurityError",
      });
    });

    test("revocation blocks replay and closes an already connected socket", async ({
      page,
      request,
    }) => {
      await page.goto(`${origin}/app`);
      await page.evaluate(async (url) => {
        const target = new URL(url);
        target.protocol = "ws:";
        target.pathname = target.pathname.replace("/vnc.html", "/hold");
        const socket = new WebSocket(target);
        const state = window as unknown as { screenClosed: boolean };
        state.screenClosed = false;
        socket.onclose = () => {
          state.screenClosed = true;
        };
        await new Promise<void>((resolve, reject) => {
          socket.onmessage = () => resolve();
          socket.onerror = () => reject(new Error("socket failed"));
        });
      }, screenUrl);
      authorized = false;
      try {
        expect((await request.get(screenUrl)).status()).toBe(403);
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { screenClosed: boolean }).screenClosed),
          )
          .toBe(true);
      } finally {
        authorized = true;
      }
    });

    for (const sandbox of ["allow-scripts allow-pointer-lock", null]) {
      test(`iframe remains isolated with sandbox attribute ${sandbox ?? "absent"}`, async ({
        page,
      }) => {
        const app = await page.goto(`${origin}/app`);
        // The app's own policy must still let it frame the screen proxy.
        if (mode === "preview") {
          expect(app?.headers()["content-security-policy"]).toContain("frame-src 'self'");
        }
        await page.evaluate(
          ({ url, sandbox }) => {
            const reports = (window as unknown as { screenReports: unknown[] }).screenReports ?? [];
            (window as unknown as { screenReports: unknown[] }).screenReports = reports;
            window.addEventListener("message", (event) => reports.push(event.data));
            const frame = document.createElement("iframe");
            if (sandbox !== null) frame.setAttribute("sandbox", sandbox);
            frame.src = url;
            document.body.append(frame);
          },
          { url: screenUrl, sandbox },
        );
        const body = page.frameLocator("iframe").locator("body");
        await expect(body).toContainText('"socket":"ok"');
        // The rewritten page tells the app it ran, even though the app cannot look inside it.
        expect(
          await page.evaluate(
            () => (window as unknown as { screenReports: unknown[] }).screenReports,
          ),
        ).toEqual([{ rakazoScreen: "loading" }]);
        expect(JSON.parse(await body.innerText())).toEqual({
          asset: "module loaded",
          socket: "ok",
          cookie: "blocked",
          storage: null,
          session: "v",
          webcodecs: false,
          realStorage: "SecurityError",
          parent: "blocked",
          api: "blocked",
        });
      });
    }
  });
}
