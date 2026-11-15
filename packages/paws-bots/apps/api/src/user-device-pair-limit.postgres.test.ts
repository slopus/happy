import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailEmulator, FakeSandboxProvider, USER_DEVICE_LIMIT } from "@rakazo/adapters";
import { USER_DEVICE_PAIR_PATH } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseUrl)("pairing holds the per-user device limit under races", () => {
  let handles: AppHandles;
  let dataDir: string;
  const email = new EmailEmulator();
  const stamp = Date.now();
  let account = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-device-pair-limit-"));
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      sandbox: new FakeSandboxProvider(),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin,
      authUrl: webOrigin,
      email,
    });
  });

  afterAll(async () => {
    await handles?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function auth(path: string, body: object, cookie = "") {
    const response = await handles.app.request(`/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: webOrigin,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
    return response;
  }

  async function newAccount() {
    const address = `device-pair-limit-${stamp}-${++account}@example.test`;
    const password = "test-password-123";
    await auth("/sign-up/email", { email: address, password, name: "Owner" });
    const signIn = async () =>
      sessionCookieHeader(await auth("/sign-in/email", { email: address, password }));
    return { signIn };
  }

  const pairRequest = (cookie: string, name: string) =>
    handles.app.request(USER_DEVICE_PAIR_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name, platform: "darwin" }),
    });

  async function pair(cookie: string) {
    const response = await pairRequest(cookie, "Desktop");
    expect(response.status).toBe(201);
    return (await response.json()) as { userId: string };
  }

  it("keeps exactly the limit when two pairings race at it", async () => {
    const owner = await newAccount();
    const cookie = await owner.signIn();
    let userId = "";
    for (let index = 0; index < USER_DEVICE_LIMIT - 1; index += 1)
      userId = (await pair(cookie)).userId;

    // Hold the account row, so both pairings count before either insert commits:
    // the insert needs a key share of that row and waits for the update lock.
    const racing: Array<Promise<Response>> = [];
    await runAsSystem("hold the account row while pairings race", () =>
      handles.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
          const [held] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          racing.push(
            Promise.resolve(pairRequest(cookie, "Racer A")),
            Promise.resolve(pairRequest(cookie, "Racer B")),
          );
          // Count only sessions queued behind this holder, directly or behind a queued
          // pairing, in this database; poll outside the transaction so every check reads
          // fresh activity instead of the transaction's cached snapshot.
          await vi.waitFor(async () => {
            const [row] = await runAsSystem(
              "count pairings queued behind the held row",
              () =>
                handles.prisma.$queryRaw<Array<{ waiters: number }>>`
                WITH RECURSIVE queued(pid) AS (
                  SELECT pid FROM pg_stat_activity
                  WHERE datname = current_database() AND ${held!.pid}::int = ANY(pg_blocking_pids(pid))
                  UNION
                  SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
                  WHERE a.datname = current_database()
                )
                SELECT count(*)::int AS waiters FROM queued`,
            );
            expect(row?.waiters).toBeGreaterThanOrEqual(2);
          });
        },
        { timeout: 20_000 },
      ),
    );

    const statuses = (await Promise.all(racing)).map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);
    const active = await runAsSystem("count the account's paired computers", () =>
      handles.prisma.userDevice.count({ where: { userId, revokedAt: null } }),
    );
    expect(active).toBe(USER_DEVICE_LIMIT);
  });
});
