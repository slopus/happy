import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("ticket board app wiring", () => {
  it.each([false, true])("threads the environment flag through HTTP (%s)", async (enabled) => {
    vi.stubEnv("TICKET_BOARD_ENABLED", String(enabled));
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-board-test-"));
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: "http://127.0.0.1:5173",
      authUrl: "http://127.0.0.1:5173",
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({
          email: `board-${enabled}-${Date.now()}@rakazo.test`,
          password: "test-password-123",
          name: "Board tester",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const call = (procedure: string) =>
        handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({ json: {} }),
        });
      const me = await call("me");
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ json: { ticketBoardEnabled: enabled } });
      const bootstrap = await call("bootstrap");
      expect(bootstrap.status).toBe(200);
      expect(await bootstrap.json()).toMatchObject({
        json: { me: { ticketBoardEnabled: enabled } },
      });
      const boards = await call("boards/list");
      expect(boards.status).toBe(enabled ? 200 : 404);
      if (enabled) expect(await boards.json()).toMatchObject({ json: expect.any(Array) });
      else expect(await boards.json()).toMatchObject({ json: { code: "NOT_FOUND" } });
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
});
