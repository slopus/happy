import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { HOST_COMPUTER_MAX_BYTES } from "./host-computer-protocol.js";
import { createHostComputerRunner } from "./host-computer-runner.js";
import type { HostScreen } from "./host-screen.js";

/** No renderer receives the credential. Docker reaches this listener through its host gateway. */
export async function startHostComputerServer(options: {
  root: string;
  token: string;
  port?: number;
  hostname?: string;
  /** Drives this computer's apps. Owned by the caller, which closes it. */
  screen?: HostScreen;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error("Invalid local computer credential");
  const runner = createHostComputerRunner({ root: options.root, screen: options.screen });
  const secret = Buffer.from(`Bearer ${options.token}`);
  const server = createServer(async (request, response) => {
    const credential = Buffer.from(request.headers.authorization ?? "");
    // Reject browser-origin requests even when they somehow obtain a credential; no CORS.
    if (
      request.headers.origin ||
      credential.length !== secret.length ||
      !timingSafeEqual(credential, secret)
    ) {
      response.writeHead(401).end();
      return;
    }
    if (!runner.isEnabled()) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/computer") {
      response.writeHead(404).end();
      return;
    }
    const call = runner.begin();
    if (!call) {
      response.writeHead(429).end();
      return;
    }
    call.signal.addEventListener("abort", () => response.destroy(), { once: true });
    response.once("close", call.abort);
    const timer = setTimeout(call.abort, 30_000);
    timer.unref();
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > HOST_COMPUTER_MAX_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      clearTimeout(timer);
      const outcome = await call.run(input, {
        open() {
          response.writeHead(200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
          });
          response.flushHeaders();
        },
        async write(frame) {
          if (response.destroyed) return;
          if (!response.write(`${JSON.stringify(frame)}\n`))
            await once(response, "drain", { signal: call.signal });
        },
      });
      if (outcome === "invalid") response.writeHead(400).end();
      else if (outcome === "disabled") response.writeHead(403).end();
      else if (outcome === "busy") response.writeHead(429).end();
      else if (!call.signal.aborted) response.end();
    } catch {
      // Unreadable or malformed bodies never reach the runner.
      if (!response.headersSent) response.writeHead(400);
      if (!response.destroyed)
        response.end(`${JSON.stringify({ error: "Local computer operation failed" })}\n`);
    } finally {
      clearTimeout(timer);
      call.end();
      response.removeListener("close", call.abort);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local computer unavailable");
  return {
    port: address.port,
    isEnabled: runner.isEnabled,
    setEnabled: runner.setEnabled,
    async close() {
      runner.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
