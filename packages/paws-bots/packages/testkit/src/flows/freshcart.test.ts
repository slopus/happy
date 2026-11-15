import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("./sites/freshcart/server.py", import.meta.url));
const TOKEN = "test-admin-token";
const hasPython = spawnSync("python3", ["--version"]).status === 0;

interface AdminState {
  seed: number;
  credentials: { email: string; password: string };
  outOfStock: string[];
  pendingCode: string | null;
  logins: number;
  failedLogins: number;
  orders: {
    id: string;
    items: { sku: string; qty: number; unitPrice: number }[];
    slot: { id: string; label: string };
    subtotal: number;
    deliveryFee: number;
    total: number;
  }[];
}

interface Slot {
  id: string;
  full: boolean;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

describe.skipIf(!hasPython)("freshcart site (requires python3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "freshcart-"));
  const stateFile = join(dir, "state.json");
  let proc: ChildProcess | undefined;
  let base = "";
  let cookie = "";

  async function start() {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn("python3", [
      SERVER,
      ...["--port", String(port), "--seed", "7"],
      ...["--admin-token", TOKEN, "--state-file", stateFile],
    ]);
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(base).then(
          (r) => r.ok,
          () => false,
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("freshcart did not start");
  }

  async function stop() {
    const exited = new Promise((r) => proc?.once("exit", r));
    proc?.kill();
    await exited;
  }

  async function call(path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, data: await res.json() };
  }

  async function admin(): Promise<AdminState> {
    const res = await fetch(`${base}/__admin/state`, {
      headers: { "x-admin-token": TOKEN },
    });
    return res.json();
  }

  beforeAll(start);
  afterAll(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the store page and guards admin and shop APIs", async () => {
    const page = await fetch(base).then((r) => r.text());
    expect(page).toContain("<title>Freshcart</title>");
    expect((await fetch(`${base}/__admin/state`)).status).toBe(403);
    expect((await call("/api/products")).status).toBe(401);
  });

  it("derives credentials and stock from the seed", async () => {
    const state = await admin();
    expect(state.seed).toBe(7);
    expect(state.credentials.email).toBe("shopper@example.test");
    expect(state.credentials.password).toMatch(/^fresh-[a-z]+-\d{2}$/);
    expect(state.outOfStock).toHaveLength(2);
    expect(state.pendingCode).toBeNull();
  });

  it("signs in with a password and a two-factor code", async () => {
    const { credentials } = await admin();
    const wrong = await call("/api/login", { ...credentials, password: "x" });
    expect(wrong.status).toBe(401);
    expect((await call("/api/login", credentials)).status).toBe(200);

    const { pendingCode, failedLogins } = await admin();
    expect(pendingCode).toMatch(/^\d{6}$/);
    expect(failedLogins).toBe(1);
    const badCode = pendingCode === "000000" ? "111111" : "000000";
    expect((await call("/api/verify", { code: badCode })).status).toBe(401);

    const ok = await call("/api/verify", { code: pendingCode });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
    cookie = ok.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await call("/api/me")).data.email).toBe("shopper@example.test");
    expect(await admin()).toMatchObject({ logins: 1, pendingCode: null });
  });

  it("places a valid order and rejects invalid ones", async () => {
    const { outOfStock } = await admin();
    const { products } = (await call("/api/products")).data as {
      products: { sku: string; inStock: boolean }[];
    };
    expect(products.length).toBeGreaterThanOrEqual(36);
    expect(products.filter((p) => !p.inStock).map((p) => p.sku)).toEqual(
      expect.arrayContaining(outOfStock),
    );
    const { slots } = (await call("/api/slots")).data as { slots: Slot[] };
    expect(slots).toHaveLength(5);
    const open = slots.find((s) => !s.full)?.id;
    const full = slots.find((s) => s.full)?.id;
    const item = { sku: "whole-milk-2l", qty: 2 };

    const rejections = [
      { items: [{ sku: outOfStock[0], qty: 1 }], slot: open },
      { items: [item], slot: full },
      { items: [{ ...item, qty: 21 }], slot: open },
      { items: [], slot: open },
    ];
    for (const body of rejections) {
      expect((await call("/api/order", body)).status).toBeGreaterThanOrEqual(400);
    }

    const placed = await call("/api/order", {
      items: [item, { sku: "spaghetti", qty: 1 }],
      slot: open,
    });
    expect(placed.status).toBe(200);
    expect(placed.data).toMatchObject({
      id: "FC-1042",
      subtotal: 249 * 2 + 119,
      deliveryFee: 399,
      total: 249 * 2 + 119 + 399,
    });
    const big = await call("/api/order", {
      items: [{ sku: "laundry-liquid", qty: 6 }],
      slot: open,
    });
    expect(big.data).toMatchObject({ id: "FC-1043", deliveryFee: 0 });
    const { orders } = (await call("/api/orders")).data;
    expect(orders.map((o: { id: string }) => o.id)).toEqual(["FC-1043", "FC-1042"]);
    expect((await admin()).orders[0]?.items).toEqual([
      expect.objectContaining({ ...item, unitPrice: 249 }),
      expect.objectContaining({ sku: "spaghetti", qty: 1 }),
    ]);
  });

  it("keeps sessions and orders across a restart, and resets", async () => {
    await stop();
    await start();
    expect((await call("/api/me")).status).toBe(200);
    expect((await admin()).orders).toHaveLength(2);

    const reset = await fetch(`${base}/__admin/reset`, {
      method: "POST",
      headers: { "x-admin-token": TOKEN },
    });
    expect(reset.status).toBe(200);
    expect(await admin()).toMatchObject({ orders: [], logins: 0 });
    expect((await call("/api/me")).status).toBe(401);
  });
});
