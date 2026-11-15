import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailEmulator, FakeSandboxProvider } from "@rakazo/adapters";
import { runAsSystem } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "welcomes a new account once and honors its one-click unsubscribe",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-welcome-"));
    const email = new EmailEmulator();
    const handles = await createApp({
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
      welcomeEmailEnabled: true,
      email,
    });
    const address = `welcome-${Date.now()}@example.test`;
    const credentials = { email: address, password: "test-password-123" };
    const post = (path: string, body: object) =>
      handles.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: webOrigin },
        body: JSON.stringify(body),
      });
    const welcomes = () => email.sent.filter((message) => message.subject === "Welcome to Rakazo");
    try {
      expect((await post("/api/auth/sign-up/email", { ...credentials, name: "New" })).status).toBe(
        200,
      );
      await vi.waitFor(() => expect(welcomes()).toHaveLength(1));
      expect(welcomes()[0]!.to).toBe(address);

      expect((await post("/api/auth/sign-in/email", credentials)).status).toBe(200);

      const header = welcomes()[0]!.headers!["List-Unsubscribe"]!;
      const unsubscribe = new URL(header.slice(1, -1));
      const response = await handles.app.request(unsubscribe.pathname + unsubscribe.search, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      expect(response.status).toBe(200);
      const user = await handles.prisma.user.findUniqueOrThrow({ where: { email: address } });
      expect(user.marketingEmailOptOutAt).toBeInstanceOf(Date);
      expect(welcomes()).toHaveLength(1);

      // Reopen the claim so two sign-ins race for an unsent welcome.
      const userId = user.id;
      await runAsSystem("reopen the welcome claim", () =>
        handles.prisma.emailSend.deleteMany({ where: { userId } }),
      );
      const signIns = await Promise.all([
        post("/api/auth/sign-in/email", credentials),
        post("/api/auth/sign-in/email", credentials),
      ]);
      expect(signIns.map((response) => response.status)).toEqual([200, 200]);
      await vi.waitFor(() => expect(welcomes()).toHaveLength(2));

      const older = { email: `older-${Date.now()}@example.test`, password: "test-password-123" };
      expect((await post("/api/auth/sign-up/email", { ...older, name: "Older" })).status).toBe(200);
      await vi.waitFor(() => expect(welcomes()).toHaveLength(3));
      await runAsSystem("age an account and reopen its welcome claim", async () => {
        const { id } = await handles.prisma.user.update({
          where: { email: older.email },
          data: { createdAt: new Date("2020-01-01T00:00:00Z") },
        });
        await handles.prisma.emailSend.deleteMany({ where: { userId: id } });
      });
      expect((await post("/api/auth/sign-in/email", older)).status).toBe(200);
      expect(welcomes()).toHaveLength(3);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
