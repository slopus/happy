import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import type { PreviewServer } from "vite";
import { preview } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { apiProxy, hostAllowed } from "./api-proxy.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/** A stand-in API that accepts upgrades and echoes the headers each request arrived with. */
async function startApi() {
  const upgrades: http.IncomingHttpHeaders[] = [];
  const api = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
  api.on("upgrade", (req, socket) => {
    upgrades.push(req.headers);
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => api.close(() => resolve())));
  return { target: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, upgrades };
}

async function startPreview(
  target: string,
  allowedHosts: string[] | true = ["app.example.test", ".team.example.test"],
) {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-api-proxy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "index.html"), "<!doctype html>");
  const server: PreviewServer = await preview({
    root,
    configFile: false,
    logLevel: "silent",
    preview: {
      host: "127.0.0.1",
      port: 0,
      allowedHosts,
      proxy: apiProxy(target, () => allowedHosts),
    },
  });
  cleanup.push(() => server.close());
  return (server.httpServer.address() as AddressInfo).port;
}

function upgrade(
  port: number,
  options: { path?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
) {
  return new Promise<number | undefined>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: options.path ?? USER_DEVICE_CONNECT_PATH,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...options.headers,
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.setTimeout(options.timeoutMs ?? 3_000, () =>
      request.destroy(new Error("upgrade was never answered")),
    );
    request.end();
  });
}

describe("apiProxy", () => {
  it("forwards the device socket and preserves authentication, origin and address headers", async () => {
    const { target, upgrades } = await startApi();
    const port = await startPreview(target);

    await expect(
      upgrade(port, {
        path: `${USER_DEVICE_CONNECT_PATH}?v=1`,
        headers: {
          Authorization: "Bearer fake-device-token",
          Origin: "https://app.example.test",
          "X-Forwarded-For": "203.0.113.9",
        },
      }),
    ).resolves.toBe(101);
    expect(upgrades).toEqual([
      expect.objectContaining({
        authorization: "Bearer fake-device-token",
        origin: "https://app.example.test",
        "x-forwarded-for": "203.0.113.9, 127.0.0.1",
      }),
    ]);
  });

  it("appends the hop it saw to an API request's forwarded address", async () => {
    const { target } = await startApi();
    const port = await startPreview(target);

    const response = await fetch(`http://127.0.0.1:${port}/api/devices`, {
      headers: { "X-Forwarded-For": "203.0.113.9" },
    });
    expect(await response.json()).toMatchObject({ "x-forwarded-for": "203.0.113.9, 127.0.0.1" });
  });

  it.each([
    "/api/threads",
    "/rpc",
    "/unrelated",
    `${USER_DEVICE_CONNECT_PATH}%2f..%2fthreads`,
    `${USER_DEVICE_CONNECT_PATH}x`,
    `${USER_DEVICE_CONNECT_PATH}/../../threads`,
  ])("forwards no other upgrade path, such as %s", async (path) => {
    const { target, upgrades } = await startApi();
    const port = await startPreview(target);

    await expect(upgrade(port, { path, timeoutMs: 500 })).rejects.toThrow(
      "upgrade was never answered",
    );
    expect(upgrades).toHaveLength(0);
  });

  it("lets any host through when the server allows every host", async () => {
    const { target, upgrades } = await startApi();
    const port = await startPreview(target, true);

    await expect(upgrade(port, { headers: { Host: "evil.example" } })).resolves.toBe(101);
    expect(upgrades).toHaveLength(1);
  });

  it("refuses a device socket for a host the server does not serve", async () => {
    const { target, upgrades } = await startApi();
    const port = await startPreview(target);

    await expect(upgrade(port, { headers: { Host: "evil.example" } })).resolves.toBe(404);
    await expect(upgrade(port, { headers: { Host: "app.example.test" } })).resolves.toBe(101);
    expect(upgrades).toHaveLength(1);
  });
});

describe("hostAllowed", () => {
  const allowed = ["app.example.test", ".team.example.test"];
  const cases: [string, boolean][] = [
    ["app.example.test", true],
    ["app.example.test:5173", true],
    ["team.example.test", true],
    ["a.team.example.test", true],
    ["localhost:5173", true],
    ["web.localhost", true],
    ["127.0.0.1:5173", true],
    ["192.0.2.10:5173", true],
    ["[::1]:5173", true],
    ["file:x", true],
    ["chrome-extension:abc", true],
    ["evil.example", false],
    ["app.example.test.evil.example", false],
    ["evilteam.example.test", false],
    ["bad host", false],
    ["APP.example.test", false],
    ["evil@app.example.test", false],
    ["app.example.test/x", false],
    ["%61pp.example.test", false],
    ["0x7f.1", false],
    ["[::1", false],
  ];

  it("matches Vite's own check for plain requests on every case", async () => {
    const { target } = await startApi();
    // A copy, because Vite adds its own listening host to the list it is given.
    const port = await startPreview(target, [...allowed]);
    for (const [host, expected] of cases) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/", headers: { Host: host } }, (response) => {
            response.resume();
            resolve(response.statusCode);
          })
          .on("error", reject);
      });
      expect({ host, status }).toEqual({ host, status: expected ? 200 : 403 });
      expect({ host, allowed: hostAllowed(host, allowed) }).toEqual({ host, allowed: expected });
    }
  });

  it("allows a missing host like Vite", () => {
    expect(hostAllowed(undefined, allowed)).toBe(true);
  });
});
