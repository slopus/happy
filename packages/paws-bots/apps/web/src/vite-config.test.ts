import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import type { ProxyOptions, UserConfig } from "vite";
import { createServer, loadConfigFromFile, preview } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVICE_SOCKET } from "./api-proxy.js";

const configFile = path.resolve(import.meta.dirname, "../vite.config.ts");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

function upgrade(port: number, host: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: USER_DEVICE_CONNECT_PATH,
      headers: {
        Host: host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
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
    request.setTimeout(3_000, () => request.destroy(new Error("upgrade was never answered")));
    request.end();
  });
}

/** Points the config's API proxy at a stand-in API that accepts every upgrade. */
async function useStandInApi() {
  const api = http.createServer((_req, res) => res.end());
  api.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => api.close(() => resolve())));
  vi.stubEnv("API_PROXY_TARGET", `http://127.0.0.1:${(api.address() as AddressInfo).port}`);
  vi.stubEnv("RAKAZO_HOST", "app.example.test");
  vi.stubEnv("RAKAZO_ALLOWED_HOSTS", ".team.example.test");
  vi.stubEnv("SCREEN_PROXY_SECRET", "test-screen-proxy-secret-0123456789abcdef");
  // Lingui's plugin finds its config from the working directory, as `vite` runs it.
  vi.spyOn(process, "cwd").mockReturnValue(path.dirname(configFile));
}

describe("vite.config", () => {
  it.each([undefined, "6300"])(
    "reads the root environment port, with shell override %s",
    async (shellPort) => {
      const mode = `port-test-${randomUUID()}`;
      const envFile = path.resolve(path.dirname(configFile), `../../.env.${mode}`);
      cleanup.push(() => rm(envFile, { force: true }));
      await writeFile(envFile, "WEB_PORT=6200\n", { flag: "wx" });
      vi.stubEnv("WEB_PORT", shellPort);
      vi.spyOn(process, "cwd").mockReturnValue(path.dirname(configFile));

      const loaded = await loadConfigFromFile({ command: "serve", mode }, configFile);
      expect(loaded?.config.server?.port).toBe(shellPort ? 6300 : 6200);
      expect(loaded?.config.preview?.port).toBe(shellPort ? 6300 : 6200);
    },
  );

  it("loads and forwards only the device socket's upgrades", async () => {
    const loaded = await loadConfigFromFile({ command: "serve", mode: "production" }, configFile);
    const config = loaded?.config as UserConfig;
    for (const proxy of [config.server?.proxy, config.preview?.proxy]) {
      const upgrades = Object.entries(proxy ?? {})
        .filter(([, options]) => (options as ProxyOptions).ws)
        .map(([context]) => context);
      expect(upgrades).toEqual([DEVICE_SOCKET]);
      expect(proxy).toHaveProperty("/api");
    }
  });

  it("lets the device socket through for the hosts the preview server serves", async () => {
    await useStandInApi();
    const outDir = await mkdtemp(path.join(tmpdir(), "rakazo-vite-config-"));
    cleanup.push(() => rm(outDir, { recursive: true, force: true }));
    await writeFile(path.join(outDir, "index.html"), "<!doctype html>");

    // Hosts given here reach only the preview server's list, not the dev server's.
    const server = await preview({
      configFile,
      root: path.dirname(configFile),
      mode: "production",
      logLevel: "silent",
      build: { outDir },
      preview: { host: "127.0.0.1", port: 0, allowedHosts: ["preview.example.test"] },
    });
    cleanup.push(() => server.close());
    const { port } = server.httpServer.address() as AddressInfo;

    await expect(upgrade(port, "app.example.test")).resolves.toBe(101);
    await expect(upgrade(port, "a.team.example.test:443")).resolves.toBe(101);
    await expect(upgrade(port, "preview.example.test")).resolves.toBe(101);
    await expect(upgrade(port, "evil.example")).resolves.toBe(404);
  });

  it("lets the device socket through for the hosts the dev server serves", async () => {
    await useStandInApi();

    // Hosts given here reach only the dev server's list, not the preview server's.
    const server = await createServer({
      configFile,
      root: path.dirname(configFile),
      mode: "development",
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, hmr: false, allowedHosts: ["dev.example.test"] },
    });
    cleanup.push(() => server.close());
    await server.listen();
    const { port } = server.httpServer!.address() as AddressInfo;

    await expect(upgrade(port, "app.example.test")).resolves.toBe(101);
    await expect(upgrade(port, "dev.example.test")).resolves.toBe(101);
    await expect(upgrade(port, "evil.example")).resolves.toBe(404);
  });
});
