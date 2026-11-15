import { createHash, timingSafeEqual } from "node:crypto";
import { hasActiveComputerControl } from "@rakazo/adapters";
import { openScreenCapability, SCREEN_TARGET_ENDPOINT } from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { Hono } from "hono";
import { requestBodyLimit } from "./request-body-limit.js";

export function mountScreenTarget(app: Hono, prisma: PrismaClient, secret: string) {
  app.post(SCREEN_TARGET_ENDPOINT, requestBodyLimit(16 * 1024), async (c) => {
    c.header("cache-control", "no-store");
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (
      !secret ||
      supplied.length === 0 ||
      !timingSafeEqual(
        createHash("sha256").update(supplied).digest(),
        createHash("sha256").update(expected).digest(),
      )
    )
      return c.body(null, 403);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.path !== "string") return c.body(null, 403);
    const capability = openScreenCapability(body.path, secret);
    if (!capability) return c.body(null, 403);
    const { scope, target } = capability;
    // The sealed capability, not a session, names the bot and computer.
    const bot = await runAsSystem("check a screen proxy capability", () =>
      prisma.bot.findFirst({
        where: {
          id: scope.botId,
          computerId: scope.computerId,
          archivedAt: null,
          screenGeneration: scope.botGeneration,
        },
        select: {
          computer: {
            select: {
              screenGeneration: true,
              providerRef: true,
              state: true,
              controlHolder: true,
              controlLeaseId: true,
              controlBotId: true,
              controlLeaseExpiresAt: true,
            },
          },
        },
      }),
    );
    const computer = bot?.computer;
    if (
      !computer ||
      computer.screenGeneration !== scope.computerGeneration ||
      !computer.providerRef ||
      !["running", "booting", "suspending"].includes(computer.state) ||
      (target.interactive &&
        (!hasActiveComputerControl(computer) ||
          !scope.controlLeaseId ||
          computer.controlLeaseId !== scope.controlLeaseId ||
          computer.controlBotId !== scope.botId))
    )
      return c.body(null, 403);
    return c.json(target);
  });
}
