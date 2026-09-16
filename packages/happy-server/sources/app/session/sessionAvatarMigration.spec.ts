import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("session avatar database migration", () => {
  it("preserves existing sessions and leaves their avatar unset", async () => {
    const db = new PGlite();
    try {
      await db.exec(
        'CREATE TABLE "Session" ("id" TEXT PRIMARY KEY); INSERT INTO "Session" VALUES (\'existing\');',
      );
      await db.exec(
        await readFile(
          resolve(
            __dirname,
            "../../../prisma/migrations/20260914090000_add_session_avatars/migration.sql",
          ),
          "utf8",
        ),
      );
      expect((await db.query('SELECT * FROM "Session"')).rows).toEqual([
        { id: "existing", avatarRef: null, avatarPreview: null, avatarVersion: 0 },
      ]);
      await db.exec('INSERT INTO "Session" ("id") VALUES (\'new\');');
      expect(
        (await db.query('SELECT "avatarVersion" FROM "Session" WHERE "id" = \'new\'')).rows,
      ).toEqual([{ avatarVersion: 0 }]);
    } finally {
      await db.close();
    }
  });
});
