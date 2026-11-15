import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { contentSecurityPolicyFor } from "@rakazo/contracts/content-security-policy";

test("an isolated embedded runtime loads its decoder and connects to a TLS gateway", async ({
  page,
}) => {
  const screenPolicy = {
    screen:
      "default-src 'none'; sandbox allow-scripts allow-pointer-lock; script-src 'self'; frame-src 'self'; frame-ancestors 'self'",
    runtime:
      "default-src 'none'; sandbox allow-scripts allow-pointer-lock; script-src 'self' 'wasm-unsafe-eval' https://cdn.example.com/mqtt.js; connect-src data: wss://*.example.com:*",
  };
  const mqttUrl = "https://cdn.example.com/mqtt.js";
  const runtime = `document.addEventListener('DOMContentLoaded', async () => {
    try {
      const decoder = await fetch('data:application/wasm;base64,AGFzbQEAAAA=');
      await WebAssembly.compile(await decoder.arrayBuffer());
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = ${JSON.stringify(mqttUrl)};
        script.onload = resolve;
        script.onerror = reject;
        document.body.append(script);
      });
      const socket = new WebSocket('wss://gateway.example.com/websocket');
      socket.onmessage = async () => {
        let isolated = false;
        try { parent.document.title; } catch { isolated = true; }
        const privateApi = await fetch('/api/private', { credentials: 'include' })
          .then(() => 'accessible', () => 'blocked');
        document.body.textContent = JSON.stringify({ connected: true, isolated, privateApi });
        socket.close();
      };
    } catch { document.body.textContent = 'Runtime failed to load'; }
  });`;
  await page.route(mqttUrl, (route) =>
    route.fulfill({ contentType: "text/javascript", body: "/* Offline gateway dependency. */" }),
  );
  await page.routeWebSocket("wss://gateway.example.com/websocket", (socket) => {
    socket.send("connected");
  });
  const routes: Record<string, [string, string]> = {
    "/app": [
      "text/html",
      '<!doctype html><iframe id="screen" sandbox="allow-scripts allow-pointer-lock" src="/computer-screen/screen.html"></iframe>',
    ],
    "/computer-screen/screen.html": [
      "text/html",
      '<!doctype html><iframe id="session" src="./sdk/ASP/container.html"></iframe>',
    ],
    "/computer-screen/sdk/ASP/container.html": [
      "text/html",
      '<!doctype html><script src="/computer-screen/runtime.js"></script><body></body>',
    ],
    "/computer-screen/runtime.js": ["text/javascript", runtime],
  };
  const errors: string[] = [];
  const privateApiRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/private") privateApiRequests.push(pathname);
    if (pathname === "/third-party") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<iframe src="http://localhost:${(server.address() as AddressInfo).port}/computer-screen/screen.html"></iframe>`,
      );
      return;
    }
    const route = routes[pathname];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", route[0]);
    const policy = contentSecurityPolicyFor(pathname, undefined, screenPolicy);
    if (policy) response.setHeader("Content-Security-Policy", policy);
    if (pathname !== "/computer-screen/sdk/ASP/container.html")
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.end(route[1]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/app`);
    await expect(
      page.frameLocator("#screen").frameLocator("#session").locator("body"),
      errors.join("\n"),
    ).toHaveText(JSON.stringify({ connected: true, isolated: true, privateApi: "blocked" }), {
      timeout: 5000,
    });
    expect(privateApiRequests).toEqual([]);
    const blocked = page.waitForEvent("console", {
      predicate: (message) => message.text().includes("frame-ancestors"),
    });
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/third-party`);
    expect((await blocked).text()).toContain("frame-ancestors");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
