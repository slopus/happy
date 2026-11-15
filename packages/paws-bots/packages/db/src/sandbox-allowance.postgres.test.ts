import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";
import { sandboxRunHours } from "./sandbox-allowance.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("computer allowance hours (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `allowance-organization-${suffix}`;
  const otherOrganizationId = `allowance-other-${suffix}`;
  const spaceId = `allowance-space-${suffix}`;
  const otherSpaceId = `allowance-other-space-${suffix}`;
  const since = new Date("2026-03-01T00:00:00.000Z");
  const now = new Date("2026-03-10T00:00:00.000Z");
  let db: PrismaClient;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(databaseUrl!);
    db = created.prisma;
    prisma = asSystem(db);
    close = async () => {
      await created.prisma.$disconnect();
      await created.pool.end();
    };
    for (const [id, space] of [
      [organizationId, spaceId],
      [otherOrganizationId, otherSpaceId],
    ] as const) {
      await prisma.organization.create({
        data: { id, name: id, slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: space, organizationId: id, name: "General" } });
    }
    const run = (
      computerId: string,
      kind: string,
      startedAt: string,
      endedAt: string | null,
      space = spaceId,
    ) => ({
      computerId: `${computerId}-${suffix}`,
      spaceId: space,
      kind,
      startedAt: new Date(startedAt),
      endedAt: endedAt ? new Date(endedAt) : null,
    });
    await prisma.computerRun.createMany({
      data: [
        // Started last month: only the hour after the month began counts.
        run("a", "boat", "2026-02-28T22:00:00.000Z", "2026-03-01T01:00:00.000Z"),
        run("a", "boat", "2026-03-02T00:00:00.000Z", "2026-03-02T02:00:00.000Z"),
        // Still running: counts up to now.
        run("b", "e2b", "2026-03-09T20:00:00.000Z", null),
        // Ended before the month.
        run("c", "boat", "2026-02-10T00:00:00.000Z", "2026-02-10T05:00:00.000Z"),
        run("d", "boat", "2026-03-02T00:00:00.000Z", "2026-03-02T09:00:00.000Z", otherSpaceId),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.computerRun.deleteMany({ where: { spaceId: { in: [spaceId, otherSpaceId] } } });
    await prisma.organization.deleteMany({
      where: { id: { in: [organizationId, otherOrganizationId] } },
    });
    await close();
  });

  it("sums this period's hours by kind, clipping runs to the period and counting open runs", async () => {
    // From a tenant's request, so it must still see the organization's other Spaces.
    const hours = await runAsTenant({ spaceId: otherSpaceId, userId: "user" }, () =>
      sandboxRunHours(db, organizationId, since, now),
    );
    expect(Object.fromEntries(hours.map((row) => [row.kind, row.hours]))).toEqual({
      boat: 3,
      e2b: 4,
    });
  });
});
