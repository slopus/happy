// The built app served without Vite, for hosts that run Node but not `vite preview`: the same
// middleware, API proxy, static files and SPA fallback. Listens on WEB_HOST (127.0.0.1) and
// WEB_PORT (5173), and reads the rest of its environment as `vite preview` does.
import type { Stats } from "node:fs";
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { createServiceLogger } from "@rakazo/logging";
import { forwardsToApi, hostAllowed } from "./api-proxy.js";
import { appendForwardedFor } from "./forwarded-for.js";
import { CONTENT_TYPES } from "./missing-asset.js";
import type { Middleware } from "./preview-middleware.js";
import { attachPreviewMiddleware, webServerSettings } from "./preview-middleware.js";
import { novncRequestPath } from "./screen-proxy.js";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding"]);

function withoutHopHeaders(raw: string[], skip: readonly string[] = []) {
  const kept: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    if (!HOP_BY_HOP.has(name) && !skip.includes(name)) kept.push(raw[index]!, raw[index + 1]!);
  }
  return kept;
}

function distFile(dist: string, url: string | undefined): { file: string; stats: Stats } | null {
  let pathname = url?.split("?", 1)[0] ?? "/";
  try {
    pathname = decodeURI(pathname);
  } catch {
    return null;
  }
  const file = path.join(dist, path.normalize(pathname));
  if (!file.startsWith(dist + path.sep)) return null;
  const stats = statSync(file, { throwIfNoEntry: false });
  return stats?.isFile() ? { file, stats } : null;
}

/** `vite preview`'s static files: revalidated on every load by a weak size-and-time tag. */
function staticFiles(dist: string): Middleware {
  return (req, res, next) => {
    const found = req.method === "GET" || req.method === "HEAD" ? distFile(dist, req.url) : null;
    if (!found) return next();
    const etag = `W/"${found.stats.size}-${found.stats.mtime.getTime()}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      "content-length": found.stats.size,
      "content-type": CONTENT_TYPES[path.extname(found.file)] ?? "application/octet-stream",
      "last-modified": found.stats.mtime.toUTCString(),
      etag,
      "cache-control": "no-cache",
    });
    if (req.method === "HEAD") res.end();
    else pipeline(createReadStream(found.file), res).catch(() => res.destroy());
  };
}

/** Vite's SPA fallback: a page request with no file of its own gets the app's index.html. */
function spaFallback(dist: string): Middleware {
  return (req, _res, next) => {
    const accept = req.headers.accept;
    if (
      (req.method !== "GET" && req.method !== "HEAD") ||
      req.url === "/favicon.ico" ||
      !(!accept || accept.includes("text/html") || accept.includes("*/*"))
    ) {
      return next();
    }
    const pathname = req.url?.split("?", 1)[0] ?? "/";
    const candidates = pathname.endsWith(".html")
      ? [pathname]
      : pathname.endsWith("/")
        ? [`${pathname}index.html`]
        : [`${pathname}.html`];
    req.url = candidates.find((candidate) => distFile(dist, candidate)) ?? "/index.html";
    next();
  };
}

function apiTarget(api: string) {
  const target = new URL(api);
  const secure = target.protocol === "https:";
  return {
    secure,
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    port: Number(target.port || (secure ? 443 : 80)),
    host: target.host,
  };
}

function forwardRequests(api: string): Middleware {
  const target = apiTarget(api);
  const transport = target.secure ? https : http;
  const agent = new transport.Agent({ keepAlive: true });
  return (req, res, next) => {
    if (!forwardsToApi(req.url)) return next();
    const upstream = transport.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        agent,
        headers: [
          ...withoutHopHeaders(req.rawHeaders, ["host", "x-forwarded-for"]),
          "host",
          target.host,
          "x-forwarded-for",
          appendForwardedFor(req),
        ],
      },
      (incoming) => {
        res.writeHead(incoming.statusCode ?? 502, withoutHopHeaders(incoming.rawHeaders));
        pipeline(incoming, res).catch(() => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { "content-type": "text/plain" }).end();
    });
    res.once("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };
}

function forwardUpgrade(api: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const target = apiTarget(api);
  const upstream = target.secure
    ? tls.connect({ host: target.hostname, port: target.port, servername: target.hostname })
    : net.connect(target.port, target.hostname);
  const headers = [
    ...withoutHopHeaders(req.rawHeaders, ["host", "x-forwarded-for"]),
    "Host",
    target.host,
    "X-Forwarded-For",
    appendForwardedFor(req),
    "Connection",
    "Upgrade",
  ];
  const lines = [`${req.method ?? "GET"} ${req.url} HTTP/1.1`];
  for (let index = 0; index < headers.length; index += 2) {
    lines.push(`${headers[index]}: ${headers[index + 1]}`);
  }
  upstream.once(target.secure ? "secureConnect" : "connect", () => {
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.once("close", () => socket.destroy());
  socket.once("close", () => upstream.destroy());
}

export function createWebServer(root: string, env: NodeJS.ProcessEnv): http.Server {
  const settings = webServerSettings(
    (name) => env[name],
    createServiceLogger({ service: "rakazo-web" }),
  );
  const dist = path.join(root, "dist");
  const chain: Middleware[] = [];
  const server = http.createServer((req, res) => {
    let index = 0;
    const next = (error?: unknown) => {
      const handler = error ? undefined : chain[index++];
      if (!handler) {
        res.statusCode = error ? 500 : 404;
        res.end();
        return;
      }
      try {
        handler(req, res, next);
      } catch (thrown) {
        next(thrown);
      }
    };
    next();
  });
  const host = {
    middlewares: { use: (handler: Middleware) => chain.push(handler) },
    httpServer: server,
  };

  chain.push((req, res, next) => {
    if (hostAllowed(req.headers.host, settings.allowedHosts)) return next();
    res
      .writeHead(403, { "content-type": "text/plain" })
      .end("Blocked request. This host is not allowed.");
  });
  server.on("upgrade", (req, socket, head) => {
    if (!hostAllowed(req.headers.host, settings.allowedHosts)) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    if (!forwardsToApi(req.url, true)) {
      // The screen proxy answers its own upgrades.
      if (!novncRequestPath(req.url)) socket.destroy();
      return;
    }
    forwardUpgrade(settings.api, req, socket, head);
  });
  const afterFallback = attachPreviewMiddleware(host, settings, {
    root,
    outDir: dist,
    assetsDir: path.join(dist, "assets"),
    assetsUrl: "/assets/",
  });
  chain.push(forwardRequests(settings.api), staticFiles(dist), spaFallback(dist));
  afterFallback();
  chain.push(staticFiles(dist));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createWebServer(path.resolve(import.meta.dirname, ".."), process.env);
  const host = process.env.WEB_HOST || "127.0.0.1";
  const port = Number(process.env.WEB_PORT || 5173);
  server.listen(port, host, () => process.stdout.write(`Web listening on ${host}:${port}\n`));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}
