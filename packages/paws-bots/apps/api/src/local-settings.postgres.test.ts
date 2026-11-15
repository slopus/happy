import { randomUUID } from "node:crypto";
import { LOCAL_COMPUTER_HOST_PATH, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { asSystem, bootstrapUserSpace, createDb, runAsSystem } from "@rakazo/db";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { mountLocalComputerHost } from "./local-settings.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
it.skipIf(!databaseUrl)(
  "limits the native capability to host choice under RLS without accessing a user profile",
  async () => {
    const db = createDb(databaseUrl!);
    const system = asSystem(db.prisma);
    const userId = randomUUID();
    let spaceId: string | undefined;
    const token = "ab".repeat(32);
    try {
      await system.user.create({
        data: {
          id: userId,
          name: "Local account",
          email: "local-capability@example.test",
          emailVerified: false,
        },
      });
      ({ spaceId } = await runAsSystem("local capability fixture", () =>
        bootstrapUserSpace(
          db.prisma,
          { id: userId },
          { signupsEnabled: "false", signupAllowlist: "" },
        ),
      ));
      await system.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: userId },
      });
      const app = new Hono();
      mountLocalComputerHost(app, { token, sandboxProvider: "docker", prisma: db.prisma });
      for (const procedure of ["me", "models/list", "models/connect"]) {
        const denied = await app.request(`/api/desktop-settings/rpc/${procedure}`, {
          method: "POST",
          headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token },
          body: "{}",
        });
        expect(denied.status).toBe(403);
      }
      expect(
        (
          await app.request(LOCAL_COMPUTER_HOST_PATH, {
            method: "POST",
            headers: { cookie: "session=fake" },
            body: '{"computerHost":"this-mac"}',
          })
        ).status,
      ).toBe(401);
      const saved = await app.request(LOCAL_COMPUTER_HOST_PATH, {
        method: "POST",
        headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token },
        body: '{"computerHost":"this-mac"}',
      });
      expect(saved.status).toBe(200);
      expect(
        await system.deploymentSettings.findUnique({ where: { id: "default" } }),
      ).toMatchObject({ computerHost: "this-mac" });
    } finally {
      if (spaceId) await system.organization.delete({ where: { id: spaceId } });
      await system.user.deleteMany({ where: { id: userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);
