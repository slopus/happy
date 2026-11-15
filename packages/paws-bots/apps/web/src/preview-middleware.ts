// The web server's own middleware: what `vite preview` (and, where it applies, the dev server)
// adds in front of the built app, and what the standalone server runs without Vite.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { wuyingScreenPolicy } from "@rakazo/adapters/wuying-screen-policy";
import type { DesktopStackProbeResponse } from "@rakazo/contracts";
import {
  appContentSecurityPolicy,
  COMPUTER_SCREEN_RUNTIME_PATH,
  CSP_REPORTING_ENDPOINTS,
  contentSecurityPolicyFor,
  parseContentSecuritySources,
  parseCrispWebsiteId,
} from "@rakazo/contracts/content-security-policy";
import {
  safeScreenProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "@rakazo/core/node/screen-proxy-response";
import { resolveScreenProxySecret } from "@rakazo/core/secrets-guard";
import type { Logger } from "@rakazo/logging";
import { ASSET_ARCHIVE_DIR, archiveAssets } from "./asset-archive.js";
import { instanceThemeIndexMiddleware, instanceThemeMiddleware } from "./instance-theme.js";
import { missingAssetMiddleware } from "./missing-asset.js";
import {
  collectNovncHtml,
  injectNovncStorageShim,
  isNovncPage,
  MAX_NOVNC_HTML_BYTES,
  novncPageRequestHeaders,
  rewrittenNovncHeaders,
  shouldInjectNovncStorageShim,
} from "./novnc-html.js";
import type { ScreenTargetFailure } from "./screen-proxy.js";
import {
  checkScreenAuthorization,
  novncRequestPath,
  resolveNovncTarget,
  safeProxyHeaders,
  screenCapabilityExpiry,
  screenProbePath,
  screenProbeStatus,
  screenRefusal,
  screenUpstreamReachable,
  watchScreenAuthorization,
} from "./screen-proxy.js";

export type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;

/** What both Vite servers and the standalone server offer: a middleware chain and upgrades. */
export type WebServerHost = {
  middlewares: { use(handler: Middleware): unknown };
  httpServer: {
    on(
      event: "upgrade",
      listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): unknown;
  } | null;
};

const DESKTOP_STACK_PROBE_PATH = "/.well-known/rakazo-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-rakazo-desktop-stack-token";
const SCREEN_UPSTREAM_TIMEOUT_MS = 20_000;

function screenPolicy(url: string | undefined) {
  return url?.startsWith("/novnc/session/control/") ? "control" : "view";
}

export function socketErrorCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
}

function equalStackToken(expected: string, supplied: string | string[] | undefined) {
  if (expected === "" || typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export function attachDesktopStackProbe(
  server: WebServerHost,
  { desktopStackToken: token, imageTag }: WebServerSettings,
) {
  server.middlewares.use((req, res, next) => {
    if (req.url?.split("?", 1)[0] !== DESKTOP_STACK_PROBE_PATH) {
      next();
      return;
    }
    if (!equalStackToken(token, req.headers[DESKTOP_STACK_TOKEN_HEADER])) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const body: DesktopStackProbeResponse = { ok: true, imageTag };
    res.statusCode = 200;
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  });
}

export function sharedPageHeaders(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (req.url?.startsWith("/p/")) {
    res.setHeader("x-robots-tag", "noindex, nofollow");
    res.setHeader("referrer-policy", "no-referrer");
  }
  next();
}

export function attachNovncProxy(server: WebServerHost, settings: WebServerSettings) {
  const { api, log } = settings;
  const secret = settings.screenProxySecret();
  server.middlewares.use(async (req, res, next) => {
    const path = novncRequestPath(req.url);
    if (!path) {
      next();
      return;
    }
    req.url = path;
    const connectionId = randomUUID();
    const bindings = {
      "screen.connection_id": connectionId,
      "screen.policy": screenPolicy(req.url),
    };
    const confirmedAt = performance.now();
    // A status-only probe is answered here, after the same access check, and never forwarded.
    const probe = screenProbePath(req.url);
    let refusal: ScreenTargetFailure | undefined;
    const target = await resolveNovncTarget(probe ?? req.url, secret, api, (reason) => {
      refusal = reason;
      log.warn("screen.proxy.target_rejected", {
        ...bindings,
        "screen.transport": "http",
        reason,
      });
    });
    if (res.destroyed) return;
    if (probe) {
      // Only a connection attempt reaches the computer; the proxy writes the whole answer.
      const reachable = target ? await screenUpstreamReachable(target) : false;
      if (res.destroyed) return;
      res.statusCode = screenProbeStatus(target, refusal, reachable);
      res.setHeader("cache-control", "no-store");
      res.end();
      return;
    }
    if (!target) {
      const { status, body } = screenRefusal(refusal);
      res.statusCode = status;
      res.end(body);
      return;
    }
    const forwarded = safeProxyHeaders(req.headers, target);
    const headers = {
      // The storage shim rewrites the page, so ask for all of it, uncompressed.
      ...(isNovncPage(target.path) ? novncPageRequestHeaders(forwarded) : forwarded),
      host: `${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`,
    };
    const transport = target.protocol === "https:" ? https : http;
    let upstream: ClientRequest | undefined;
    let retries = 0;
    let retryPending = false;
    let stopChecking: () => void = () => undefined;
    const retryable = req.method === "GET";
    const scheduleRetry = (incoming?: IncomingMessage) => {
      if (!retryable || retryPending || retries >= 3 || res.destroyed) return false;
      retryPending = true;
      retries += 1;
      const delayMs = 50 * retries;
      const retry = () => {
        setTimeout(() => {
          retryPending = false;
          if (!res.destroyed) requestUpstream();
        }, delayMs);
      };
      if (incoming && !incoming.destroyed) {
        incoming.once("close", retry);
        incoming.destroy();
      } else {
        retry();
      }
      return true;
    };
    let downstreamFinished = false;
    const finishUnavailable = (reason: string, errorCode?: string) => {
      if (downstreamFinished || res.destroyed || res.writableEnded) return;
      downstreamFinished = true;
      log.warn("screen.proxy.http_failed", {
        ...bindings,
        reason,
        ...(errorCode ? { "error.code": errorCode } : {}),
      });
      stopChecking();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = 502;
      res.end(`Screen unavailable (${reason})`);
    };
    const requestUpstream = () => {
      if (res.destroyed) return;
      upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: req.method,
          headers,
          ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
        },
        (incoming) => {
          if ((incoming.statusCode ?? 502) >= 500 && scheduleRetry(incoming)) {
            return;
          }
          if ((incoming.statusCode ?? 502) >= 400) {
            log.warn("screen.proxy.http_upstream_response", {
              ...bindings,
              "http.status": incoming.statusCode ?? 502,
              "screen.retries": retries,
            });
          }
          const responseHeaders = safeScreenProxyResponseHeaders(incoming.headers);
          if (shouldInjectNovncStorageShim(responseHeaders, target.path)) {
            const declaredLength = Number(incoming.headers["content-length"] ?? 0);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_NOVNC_HTML_BYTES) {
              finishUnavailable("html_too_large");
              incoming.destroy();
              return;
            }
            void collectNovncHtml(incoming, MAX_NOVNC_HTML_BYTES)
              .then((html) => {
                if (downstreamFinished || res.destroyed || res.writableEnded) return;
                downstreamFinished = true;
                const body = injectNovncStorageShim(html, { viewOnly: !target.interactive });
                res.writeHead(incoming.statusCode ?? 502, rewrittenNovncHeaders(responseHeaders));
                res.end(body);
              })
              .catch(() => {
                finishUnavailable("html_read_failed");
              });
            return;
          }
          res.writeHead(incoming.statusCode ?? 502, responseHeaders);
          incoming.pipe(res);
        },
      );
      // A silent upstream would leave the frame blank for as long as the browser waits. The limit
      // covers only the wait for response headers; a slow or idle body after that keeps flowing.
      const request = upstream;
      const headersTimer = setTimeout(() => {
        finishUnavailable("upstream_timeout");
        request.destroy();
      }, SCREEN_UPSTREAM_TIMEOUT_MS);
      request.once("response", () => clearTimeout(headersTimer));
      request.once("close", () => clearTimeout(headersTimer));
      upstream.on("error", (error) => {
        if (
          retryable &&
          !downstreamFinished &&
          !res.headersSent &&
          !res.destroyed &&
          (retryPending || scheduleRetry())
        ) {
          return;
        }
        finishUnavailable("upstream_error", socketErrorCode(error));
      });
      if (req.method === "GET" || req.readableEnded) upstream.end();
      else req.pipe(upstream);
    };
    stopChecking = watchScreenAuthorization(
      () => checkScreenAuthorization(req.url, secret, api, target),
      (reason) => {
        log.warn("screen.proxy.http_revoked", {
          ...bindings,
          "screen.revoke_reason": reason,
        });
        upstream?.destroy();
        res.destroy();
      },
      {
        confirmedAt,
        expiresAt: screenCapabilityExpiry(req.url),
        onUnavailable: (consecutive) =>
          log.warn("screen.proxy.recheck_unavailable", {
            ...bindings,
            "screen.transport": "http",
            "screen.consecutive": consecutive,
          }),
      },
    );
    res.once("close", () => {
      stopChecking();
      upstream?.destroy();
    });
    requestUpstream();
  });

  server.httpServer?.on("upgrade", async (req, socket, head) => {
    const path = novncRequestPath(req.url);
    // Node drops its own socket error handler on upgrade, so a client reset with no listener
    // crashes the server. Other upgrades belong to Vite's HMR or the API proxy, so only their
    // errors are ignored.
    if (!path) {
      socket.on("error", () => {});
      return;
    }
    // An earlier listener refused this upgrade (for example a disallowed host).
    if (socket.destroyed || socket.writableEnded) return;
    req.url = path;
    const connectionId = randomUUID();
    const startedAt = Date.now();
    const bindings = {
      "screen.connection_id": connectionId,
      "screen.policy": screenPolicy(req.url),
    };
    let closeInitiator: "client" | "upstream" | "revoked" | undefined;
    // Listen before the access check; the close handler below tears down the upstream.
    socket.on("error", (error) => {
      log.warn("screen.proxy.websocket_error", {
        ...bindings,
        "screen.side": "client",
        "error.code": socketErrorCode(error),
      });
      closeInitiator ??= "client";
    });
    const confirmedAt = performance.now();
    const target = await resolveNovncTarget(req.url, secret, api, (reason) => {
      log.warn("screen.proxy.target_rejected", {
        ...bindings,
        "screen.transport": "websocket",
        reason,
      });
    });
    if (socket.destroyed) return;
    if (!target) {
      socket.destroy();
      return;
    }
    const upstream =
      target.protocol === "https:"
        ? tls.connect({ port: target.port, host: target.hostname, servername: target.hostname })
        : net.connect(target.port, target.hostname);
    let upgraded = false;
    let closed = false;
    const logClose = (side: "client" | "upstream") => {
      if (closed) return;
      closed = true;
      const durationMs = Date.now() - startedAt;
      const details = {
        ...bindings,
        "screen.upgraded": upgraded,
        "screen.duration_ms": durationMs,
        "screen.closed_by": closeInitiator ?? side,
      };
      if (!upgraded || durationMs < 5_000) log.warn("screen.proxy.websocket_closed", details);
      else log.info("screen.proxy.websocket_closed", details);
    };
    const stopChecking = watchScreenAuthorization(
      () => checkScreenAuthorization(req.url, secret, api, target),
      (reason) => {
        log.warn("screen.proxy.websocket_revoked", {
          ...bindings,
          "screen.revoke_reason": reason,
        });
        closeInitiator ??= "revoked";
        socket.destroy();
        upstream.destroy();
      },
      {
        confirmedAt,
        expiresAt: screenCapabilityExpiry(req.url),
        onUnavailable: (consecutive) =>
          log.warn("screen.proxy.recheck_unavailable", {
            ...bindings,
            "screen.transport": "websocket",
            "screen.consecutive": consecutive,
          }),
      },
    );
    socket.once("close", () => {
      logClose("client");
      stopChecking();
      upstream.destroy();
    });
    upstream.once("close", () => {
      logClose("upstream");
      stopChecking();
      socket.destroy();
    });
    upstream.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
      const headerLines = [
        `${req.method ?? "GET"} ${target.path} HTTP/1.1`,
        `Host: ${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`,
      ];
      for (const [key, value] of Object.entries(safeProxyHeaders(req.headers, target))) {
        headerLines.push(`${key}: ${Array.isArray(value) ? value.join(",") : value}`);
      }
      upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      const responseChunks: Buffer[] = [];
      let responseSize = 0;
      let responseTail = Buffer.alloc(0);
      const forwardHandshake = (chunk: Buffer) => {
        responseChunks.push(chunk);
        responseSize += chunk.length;
        if (responseSize > 64 * 1024) {
          log.warn("screen.proxy.websocket_handshake_failed", {
            ...bindings,
            reason: "header_too_large",
          });
          socket.destroy();
          upstream.destroy();
          return;
        }
        const boundarySearch = Buffer.concat([responseTail, chunk]);
        if (boundarySearch.indexOf("\r\n\r\n") < 0) {
          responseTail = Buffer.from(boundarySearch.subarray(-3));
          return;
        }
        const responseHead = Buffer.concat(responseChunks, responseSize);
        const safe = stripSensitiveHandshakeHeaders(responseHead);
        if (!safe) {
          log.warn("screen.proxy.websocket_handshake_failed", {
            ...bindings,
            reason: "malformed_response",
          });
          socket.destroy();
          upstream.destroy();
          return;
        }
        const status = Number(
          responseHead
            .toString("latin1", 0, responseHead.indexOf("\r\n"))
            .match(/^HTTP\/1\.\d (\d{3})/)?.[1] ?? 0,
        );
        if (status !== 101) {
          log.warn("screen.proxy.websocket_handshake_failed", {
            ...bindings,
            reason: "upstream_status",
            "http.status": status,
          });
        } else {
          upgraded = true;
          log.info("screen.proxy.websocket_upgraded", {
            ...bindings,
            "screen.duration_ms": Date.now() - startedAt,
          });
        }
        upstream.off("data", forwardHandshake);
        socket.write(safe);
        upstream.pipe(socket);
      };
      upstream.on("data", forwardHandshake);
    });
    upstream.on("error", (error) => {
      log.warn("screen.proxy.websocket_error", {
        ...bindings,
        "screen.side": "upstream",
        "error.code": socketErrorCode(error),
      });
      closeInitiator ??= "upstream";
      socket.destroy();
    });
  });
}

/** The web server's environment, read once. Invalid CSP origins throw, so it refuses to start. */
export function webServerSettings(read: (name: string) => string | undefined, log: Logger) {
  const themeFile = read("RAKAZO_THEME");
  return {
    log,
    api: read("API_PROXY_TARGET") ?? "http://127.0.0.1:3100",
    allowedHosts: [
      read("RAKAZO_HOST") ?? "localhost",
      ...(read("RAKAZO_ALLOWED_HOSTS") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ],
    screenProxySecret: () =>
      resolveScreenProxySecret({
        ...process.env,
        SCREEN_PROXY_SECRET: read("SCREEN_PROXY_SECRET"),
        SANDBOX_SUPERVISOR_TOKEN: read("SANDBOX_SUPERVISOR_TOKEN"),
        BETTER_AUTH_SECRET: read("BETTER_AUTH_SECRET"),
      }),
    performanceAssetDelayMs: Number(read("RAKAZO_PERFORMANCE_ASSET_DELAY_MS") ?? 0),
    desktopStackToken: read("RAKAZO_DESKTOP_STACK_TOKEN") ?? "",
    instanceTheme:
      themeFile &&
      instanceThemeMiddleware(themeFile, (reason) =>
        log.warn("web.instance_theme_ignored", { reason }),
      ),
    imageTag: read("RAKAZO_IMAGE_TAG") ?? "edge",
    appPolicy: appContentSecurityPolicy({
      scriptSrc: parseContentSecuritySources(
        "RAKAZO_CSP_SCRIPT_SRC",
        read("RAKAZO_CSP_SCRIPT_SRC"),
      ),
      connectSrc: parseContentSecuritySources(
        "RAKAZO_CSP_CONNECT_SRC",
        read("RAKAZO_CSP_CONNECT_SRC"),
      ),
      crisp: parseCrispWebsiteId(read("CRISP_WEBSITE_ID")) !== null,
    }),
  };
}

export type WebServerSettings = ReturnType<typeof webServerSettings>;

/**
 * Everything the built app's server adds before its proxy and static files, in order. Returns
 * what runs after the SPA fallback has resolved the page.
 */
export function attachPreviewMiddleware(
  server: WebServerHost,
  settings: WebServerSettings,
  site: { root: string; outDir: string; assetsDir: string; assetsUrl: string },
): () => void {
  const { middlewares } = server;
  middlewares.use((req, res, next) => {
    const pathname = req.url?.split("?", 1)[0] ?? "/";
    if (pathname !== COMPUTER_SCREEN_RUNTIME_PATH) res.setHeader("x-frame-options", "SAMEORIGIN");
    const policy = contentSecurityPolicyFor(pathname, settings.appPolicy, wuyingScreenPolicy);
    if (policy) {
      res.setHeader("content-security-policy", policy);
      res.setHeader("reporting-endpoints", CSP_REPORTING_ENDPOINTS);
    }
    next();
  });
  // A shared page's link is its only key: keep it out of search results and Referer.
  middlewares.use(sharedPageHeaders);
  let archive: string | null = null;
  try {
    archive = archiveAssets({
      assetsDir: site.assetsDir,
      archiveDir: path.resolve(site.root, ASSET_ARCHIVE_DIR),
      buildId: readFileSync(path.join(site.outDir, "build-id"), "utf8").trim(),
      now: Date.now(),
    });
  } catch (error) {
    settings.log.warn("web.asset_archive_failed", { "error.code": socketErrorCode(error) });
  }
  middlewares.use(missingAssetMiddleware(site.assetsDir, site.assetsUrl, archive));
  // Without RAKAZO_THEME the page never links the theme, so the default deploy is unchanged.
  if (settings.instanceTheme) middlewares.use(settings.instanceTheme);
  attachDesktopStackProbe(server, settings);
  const delayMs = settings.performanceAssetDelayMs;
  if (Number.isFinite(delayMs) && delayMs > 0) {
    middlewares.use((req, _res, next) => {
      const pathname = req.url?.split("?", 1)[0] ?? "/";
      if (["/api", "/rpc", "/novnc"].some((prefix) => pathname.startsWith(prefix))) {
        next();
        return;
      }
      setTimeout(next, delayMs);
    });
  }
  attachNovncProxy(server, settings);
  return () => {
    if (settings.instanceTheme) middlewares.use(instanceThemeIndexMiddleware(site.outDir));
  };
}
