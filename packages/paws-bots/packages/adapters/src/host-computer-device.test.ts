import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_COMPUTER_DEVICE_ID, withHostComputerScreen } from "./host-computer-device.js";
import { startHostComputerServer } from "./host-computer-server.js";
import type { HostScreen } from "./host-screen.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

const token = "cd".repeat(32);
const grantedAt = new Date("2026-11-01T00:00:00Z");

async function collect<T>(values: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const value of values) out.push(value);
  return out;
}

describe("this computer's screen on the desktop app's own server", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof startHostComputerServer>>;
  let computerHost: string | null;
  const screen: HostScreen = {
    observe: vi.fn(async (_scope, app) => ({ app, tree: "[1] button Save" })),
    act: vi.fn(async () => ({ completed: 1 })),
    close: vi.fn(async () => undefined),
  };
  const prisma = {
    deploymentSettings: {
      findUnique: async () => ({ computerHost, updatedAt: grantedAt }),
    },
  } as unknown as PrismaClient;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-host-device-"));
    server = await startHostComputerServer({ root, token, hostname: "127.0.0.1", screen });
    server.setEnabled(true);
    computerHost = "this-mac";
  });
  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  function gateway(devices?: UserDeviceGateway) {
    return withHostComputerScreen(devices, {
      prisma,
      sandboxKind: "docker",
      url: `http://127.0.0.1:${server.port}`,
      token,
    })!;
  }

  it("offers only the screen, and only while bots run on this computer", async () => {
    expect(await gateway().connected("user")).toEqual({
      deviceId: HOST_COMPUTER_DEVICE_ID,
      name: "This computer",
      platform: process.platform,
      screenOnly: true,
    });
    expect(await gateway().pairedSince("user")).toEqual(grantedAt);

    computerHost = "docker";
    expect(await gateway().connected("user")).toBeNull();
    expect(await gateway().pairedSince("user")).toBeNull();
  });

  it("is offline while the desktop app refuses access", async () => {
    server.setEnabled(false);
    expect(await gateway().connected("user")).toBeNull();
  });

  it("drives the app the request names and refuses commands", async () => {
    const observed = await collect(
      gateway().request(
        "user",
        { method: "screenObserve", botId: "bot", app: "Notepad" },
        AbortSignal.timeout(5_000),
        HOST_COMPUTER_DEVICE_ID,
      ),
    );
    expect(observed).toEqual([{ app: "Notepad", tree: "[1] button Save" }]);
    expect(screen.observe).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot" }),
      "Notepad",
      { query: undefined },
    );

    await expect(
      collect(
        gateway().request(
          "user",
          { method: "execute", botId: "bot", command: { argv: ["whoami"] } },
          AbortSignal.timeout(5_000),
          HOST_COMPUTER_DEVICE_ID,
        ),
      ),
    ).rejects.toThrow("Only screen control");
  });

  it("refuses the screen once bots stop running on this computer", async () => {
    const devices = gateway();
    computerHost = "docker";
    await expect(
      collect(
        devices.request(
          "user",
          {
            method: "screenAct",
            botId: "bot",
            app: "Notepad",
            actions: [{ kind: "click", element: 1 }],
          },
          AbortSignal.timeout(5_000),
          HOST_COMPUTER_DEVICE_ID,
        ),
      ),
    ).rejects.toThrow();
    expect(screen.act).not.toHaveBeenCalled();
  });

  it("prefers a paired computer and leaves its requests to it", async () => {
    const paired: UserDeviceGateway = {
      connected: async () => ({ deviceId: "laptop", name: "Laptop", platform: "darwin" }),
      pairedSince: async () => grantedAt,
      request: vi.fn(async function* () {
        yield "from laptop";
      }) as UserDeviceGateway["request"],
    };
    expect((await gateway(paired).connected("user"))?.deviceId).toBe("laptop");
    expect(
      await collect(
        gateway(paired).request(
          "user",
          { method: "screenObserve", botId: "bot", app: "Notes" },
          AbortSignal.timeout(5_000),
          "laptop",
        ),
      ),
    ).toEqual(["from laptop"]);
  });

  it("changes nothing off the desktop app's own server", () => {
    expect(withHostComputerScreen(undefined, { prisma, sandboxKind: "e2b", url: "x", token })).toBe(
      undefined,
    );
  });
});
