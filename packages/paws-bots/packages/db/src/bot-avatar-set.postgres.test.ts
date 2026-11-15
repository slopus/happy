import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("avatar-set migration and persistence (PostgreSQL)", () => {
  it("preserves legacy rows and defaults new bots to Original, with explicit switch/reload", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A temporary table shadows public.bots; this test never alters real bot rows.
      await client.query(
        "CREATE TEMP TABLE bots (id TEXT PRIMARY KEY, color TEXT NOT NULL) ON COMMIT DROP",
      );
      const colors = ["#8B5CF6", "#8B5CF6::shape_3", "data:image/png;base64,aGVsbG8="];
      for (const [index, color] of colors.entries())
        await client.query("INSERT INTO bots (id, color) VALUES ($1, $2)", [`old-${index}`, color]);
      for (const migration of [
        "20261030120000_bot_avatar_set",
        "20261031120000_bot_avatar_set_original_default",
      ])
        await client.query(
          await readFile(
            new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url),
            "utf8",
          ),
        );
      expect(
        (await client.query('SELECT id, color, "avatarSet" FROM bots ORDER BY id')).rows,
      ).toEqual(
        colors.map((color, index) => ({ id: `old-${index}`, color, avatarSet: "organic" })),
      );
      await client.query("INSERT INTO bots (id, color) VALUES ($1, $2)", ["new", "#3B82F6"]);
      expect(
        (await client.query('SELECT "avatarSet" FROM bots WHERE id=$1', ["new"])).rows[0].avatarSet,
      ).toBe("organic");
      await client.query('INSERT INTO bots (id, color, "avatarSet") VALUES ($1, $2, $3)', [
        "explicit",
        "#3B82F6",
        "organic",
      ]);
      await client.query('UPDATE bots SET "avatarSet"=$1 WHERE id=$2', ["rakazo", "old-0"]);
      expect(
        (await client.query('SELECT "avatarSet", color FROM bots WHERE id=$1', ["old-0"])).rows[0],
      ).toEqual({ avatarSet: "rakazo", color: colors[0] });
      expect(
        (await client.query('SELECT "avatarSet" FROM bots WHERE id=$1', ["explicit"])).rows[0]
          .avatarSet,
      ).toBe("organic");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
