import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { runAsSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

// Needs a database of its own: the first account is whichever signs up first.
it.skipIf(!databaseUrl || !process.env.COPY_TEST_DATABASE)(
  "the app-managed stack on this computer admits only its first account",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-desktop-accounts-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "docker",
      sandbox: new FakeSandboxProvider(),
      desktopStackToken: "cd".repeat(32),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin,
      authUrl: webOrigin,
    });
    // Another local user reaches the loopback port without a browser, so without an Origin.
    const post = (path: string, body: object, origin?: string) =>
      handles.app.request(`/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      });
    try {
      // Two first signups at once: exactly one becomes the account.
      const first = ["owner@example.test", "racer@example.test"].map((email) => ({
        email,
        password: "test-password-123",
      }));
      const signups = await Promise.all(
        first.map((account) => post("/sign-up/email", { ...account, name: "First" }, webOrigin)),
      );
      expect(signups.filter((response) => response.status === 200)).toHaveLength(1);
      const owner = first[signups.findIndex((response) => response.status === 200)]!;
      const loser = first.find((account) => account !== owner)!;
      expect((await post("/sign-in/email", loser, webOrigin)).status).toBeGreaterThanOrEqual(400);

      const stranger = await post("/sign-up/email", {
        email: "stranger@example.test",
        password: "test-password-123",
        name: "Stranger",
      });
      expect(stranger.status).toBe(400);
      expect(await stranger.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
      const strangers = await runAsSystem("count refused accounts", () =>
        handles.prisma.user.count({ where: { email: "stranger@example.test" } }),
      );
      expect(strangers).toBe(0);

      expect((await post("/sign-in/email", owner, webOrigin)).status).toBe(200);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
