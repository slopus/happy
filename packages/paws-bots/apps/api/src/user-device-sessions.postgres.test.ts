import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailEmulator, FakeSandboxProvider } from "@rakazo/adapters";
import { USER_DEVICE_PAIR_PATH, USER_DEVICE_PATH } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseUrl)("paired computers end with the sign-in that paired them", () => {
  let handles: AppHandles;
  let dataDir: string;
  const email = new EmailEmulator();
  const stamp = Date.now();
  let account = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-device-sessions-"));
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
    const address = `device-sessions-${stamp}-${++account}@example.test`;
    const password = "test-password-123";
    await auth("/sign-up/email", { email: address, password, name: "Owner" });
    const signIn = async (current = password) =>
      sessionCookieHeader(await auth("/sign-in/email", { email: address, password: current }));
    return { address, password, signIn };
  }

  /** What the desktop app does with the window's sign-in. */
  async function pair(cookie: string) {
    const response = await handles.app.request(USER_DEVICE_PAIR_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Desktop", platform: "darwin" }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { deviceId: string; token: string; userId: string };
  }

  /** Revokes the device when its token still works, so call it only to show that it does not. */
  const active = async (token: string) => {
    const response = await handles.app.request(`${USER_DEVICE_PATH}/self`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    return response.status !== 401;
  };
  const revokedAt = (deviceId: string) =>
    runAsSystem("read a paired computer", () =>
      handles.prisma.userDevice.findUniqueOrThrow({ where: { id: deviceId } }),
    ).then((device) => device.revokedAt);

  it("signing out ends only the computer that sign-in paired", async () => {
    const owner = await newAccount();
    const desktop = await owner.signIn();
    const phone = await owner.signIn();
    const device = await pair(desktop);
    const other = await pair(await owner.signIn());

    await auth("/sign-out", {}, phone);
    expect(await revokedAt(device.deviceId)).toBeNull();

    await auth("/sign-out", {}, desktop);
    expect(await revokedAt(device.deviceId)).toBeInstanceOf(Date);
    expect(await revokedAt(other.deviceId)).toBeNull();

    // Signing back in pairs again for the same account.
    const again = await pair(await owner.signIn());
    expect(again.userId).toBe(device.userId);
    expect(await revokedAt(again.deviceId)).toBeNull();
  });

  it("signing out everywhere ends every paired computer", async () => {
    const owner = await newAccount();
    const devices = [await pair(await owner.signIn()), await pair(await owner.signIn())];
    await auth("/revoke-sessions", {}, await owner.signIn());
    for (const device of devices) expect(await active(device.token)).toBe(false);
  });

  it("a password change that signs out other sessions ends their computers, not the caller's", async () => {
    const owner = await newAccount();
    const attacker = await pair(await owner.signIn());
    const desktop = await owner.signIn();
    const mine = await pair(desktop);
    await auth(
      "/change-password",
      {
        currentPassword: owner.password,
        newPassword: "test-password-456",
        revokeOtherSessions: true,
      },
      desktop,
    );
    expect(await revokedAt(attacker.deviceId)).toBeInstanceOf(Date);
    expect(await revokedAt(mine.deviceId)).toBeNull();
    const moved = await runAsSystem("read a paired computer", () =>
      handles.prisma.userDevice.findUniqueOrThrow({ where: { id: mine.deviceId } }),
    );
    const sessions = await runAsSystem("read sessions", () =>
      handles.prisma.session.findMany({ where: { userId: mine.userId }, select: { id: true } }),
    );
    expect(sessions.map((session) => session.id)).toContain(moved.sessionId);
  });

  it("a password reset ends every paired computer, including one paired before sessions were recorded", async () => {
    const owner = await newAccount();
    const attacker = await pair(await owner.signIn());
    const legacy = await pair(await owner.signIn());
    await runAsSystem("forget the pairing session", () =>
      handles.prisma.userDevice.update({
        where: { id: legacy.deviceId },
        data: { sessionId: null },
      }),
    );

    const linkTo = async (path: string) =>
      vi.waitFor(() => {
        const link = email.sent
          .filter((message) => message.to === owner.address)
          .map((message) => message.text.match(new RegExp(`https?://\\S*${path}\\S*`))?.[0])
          .find(Boolean);
        if (!link) throw new Error(`No ${path} email yet`);
        return new URL(link);
      });
    // Only a proven address can be reset.
    const verify = await linkTo("/verify-email");
    await handles.app.request(verify.pathname + verify.search);
    await auth("/request-password-reset", {
      email: owner.address,
      redirectTo: `${webOrigin}/reset-password`,
    });
    const resetToken = (await linkTo("/reset-password/")).pathname.split("/").at(-1);
    await auth("/reset-password", { token: resetToken, newPassword: "test-password-789" });

    expect(await active(attacker.token)).toBe(false);
    expect(await active(legacy.token)).toBe(false);
  });

  it("releases a computer whose sign-in ended while it was offline", async () => {
    const owner = await newAccount();
    const desktop = await owner.signIn();
    const device = await pair(desktop);
    // Expired, or deleted without the sign-out hook: no revocation ran.
    await runAsSystem("expire the pairing sign-in", () =>
      handles.prisma.session.updateMany({
        where: { userId: device.userId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      }),
    );
    expect(await revokedAt(device.deviceId)).toBeNull();

    const phone = await owner.signIn();
    const listed = await handles.app.request(USER_DEVICE_PATH, { headers: { cookie: phone } });
    expect((await listed.json()).devices).toEqual([]);
    const released = await runAsSystem("read a paired computer", () =>
      handles.prisma.userDevice.findUniqueOrThrow({ where: { id: device.deviceId } }),
    );
    expect(released).toMatchObject({ revokedBy: "session" });
    expect(released.revokedAt).toBeInstanceOf(Date);
  });

  it("tells a computer reconnecting after its sign-in ended why it was turned away", async () => {
    const owner = await newAccount();
    const desktop = await owner.signIn();
    const signedOut = await pair(desktop);
    const removed = await pair(await owner.signIn());
    await auth("/sign-out", {}, desktop);
    await handles.app.request(`${USER_DEVICE_PATH}/${removed.deviceId}`, {
      method: "DELETE",
      headers: { cookie: await owner.signIn() },
    });

    const reasons = await runAsSystem("read revoke reasons", () =>
      handles.prisma.userDevice.findMany({
        where: { id: { in: [signedOut.deviceId, removed.deviceId] } },
        select: { id: true, revokedBy: true },
      }),
    );
    expect(Object.fromEntries(reasons.map((row) => [row.id, row.revokedBy]))).toEqual({
      [signedOut.deviceId]: "session",
      [removed.deviceId]: "owner",
    });
  });
});
