import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

type Row = { userId: string; site: string };

/** The trusted_link_sites table, with its unique (userId, site). */
function fakeTable() {
  const rows: Row[] = [];
  const matches = (row: Row, where: Partial<Row>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
  return {
    rows,
    trustedLinkSite: {
      findMany: async ({ where, orderBy }: { where: Partial<Row>; orderBy?: unknown }) => {
        expect(orderBy).toEqual({ site: "asc" });
        return rows
          .filter((row) => matches(row, where))
          .sort((a, b) => a.site.localeCompare(b.site));
      },
      createMany: async ({ data, skipDuplicates }: { data: Row; skipDuplicates?: boolean }) => {
        const duplicate = rows.some((row) => row.userId === data.userId && row.site === data.site);
        if (duplicate && !skipDuplicates) throw new Error("unique violation");
        if (!duplicate) rows.push({ ...data });
        return { count: duplicate ? 0 : 1 };
      },
      deleteMany: async ({ where }: { where: Partial<Row> }) => {
        const before = rows.length;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (matches(rows[index]!, where)) rows.splice(index, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

function setup() {
  const table = fakeTable();
  const deps = {
    prisma: { trustedLinkSite: table.trustedLinkSite } as unknown as PrismaClient,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const client = (userId: string, spaceId = "space-1") =>
    createRouterClient(createRouter(deps), {
      context: {
        actor: {
          userId,
          spaceId,
          email: `${userId}@rakazo.test`,
          isDeploymentOwner: false,
        } satisfies Actor,
      } as never,
    }).trustedLinkSites;
  return { rows: table.rows, client };
}

describe("trusted link sites", () => {
  it("stores the site of a link, not the link, and only once", async () => {
    const { rows, client } = setup();
    const alice = client("user-a");
    await expect(alice.trust({ url: "https://docs.example.com/a?b=1" })).resolves.toEqual({
      site: "example.com",
    });
    await expect(alice.trust({ url: "https://www.example.com/" })).resolves.toEqual({
      site: "example.com",
    });
    await expect(alice.trust({ url: "https://alice.github.io/x" })).resolves.toEqual({
      site: "alice.github.io",
    });
    expect(rows).toEqual([
      { userId: "user-a", site: "example.com" },
      { userId: "user-a", site: "alice.github.io" },
    ]);
    await expect(alice.list()).resolves.toEqual(["alice.github.io", "example.com"]);
  });

  it("lists and removes only the signed-in user's sites, in any space", async () => {
    const { rows, client } = setup();
    await client("user-a").trust({ url: "https://example.com" });
    await client("user-b").trust({ url: "https://example.com" });
    await client("user-b").trust({ url: "https://example.org" });

    await expect(client("user-a", "space-2").list()).resolves.toEqual(["example.com"]);
    await expect(client("user-a").remove({ site: "example.org" })).resolves.toEqual({ ok: true });
    await expect(client("user-a").remove({ site: "example.com" })).resolves.toEqual({ ok: true });
    await expect(client("user-a").list()).resolves.toEqual([]);
    expect(rows).toEqual([
      { userId: "user-b", site: "example.com" },
      { userId: "user-b", site: "example.org" },
    ]);
  });

  it.each(["not a url", "mailto:someone@example.com", "javascript:alert(1)", "/threads/1"])(
    "refuses %s",
    async (url) => {
      const { rows, client } = setup();
      await expect(client("user-a").trust({ url })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(rows).toEqual([]);
    },
  );

  it("needs a signed-in user", async () => {
    const anonymous = createRouterClient(createRouter({ prisma: {} } as unknown as RouterDeps), {
      context: {} as never,
    }).trustedLinkSites;
    await expect(anonymous.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
