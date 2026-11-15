import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../prisma/migrations/20260901120000_messaging_surface/migration.sql",
  ),
  "utf8",
);

/** Close-out predicate from the messaging_surface migration. */
function closeOutPending(
  rows: Array<{ status: string; identityId: string | null; threadId: string | null }>,
) {
  return rows.map((row) =>
    row.status === "pending" && row.identityId === null && row.threadId === null
      ? { ...row, status: "failed" }
      : row,
  );
}

describe("messaging_surface outbound close-out", () => {
  it("fails only pending rows that lack identityId and threadId", () => {
    expect(migrationSql).toMatch(
      /UPDATE "messaging_outbound"\s+SET "status" = 'failed'\s+WHERE "status" = 'pending'\s+AND "identityId" IS NULL\s+AND "threadId" IS NULL/,
    );
    expect(migrationSql).not.toMatch(
      /UPDATE "messaging_outbound" SET "status" = 'failed' WHERE "status" = 'pending';/,
    );
  });

  it("keeps identity-mapped DMs pending and fails unaddressable group/intro rows", () => {
    const after = closeOutPending([
      { status: "pending", identityId: "ident-1", threadId: null },
      { status: "pending", identityId: null, threadId: null },
      { status: "pending", identityId: null, threadId: "sendblue:group:1" },
      { status: "sent", identityId: null, threadId: null },
    ]);
    expect(after.map((row) => row.status)).toEqual(["pending", "failed", "pending", "sent"]);
  });
});

describe("messaging_surface channel close-out", () => {
  it("retires memberships of the legacy-prefixed channels", () => {
    // The prefixed channels can never receive traffic again; leaving their
    // members active would let a stale row answer the owner's next LEAVE.
    expect(migrationSql).toMatch(
      /UPDATE "messaging_channel_members" m\s+SET "status" = 'left'\s+FROM "messaging_channels" c\s+WHERE m\."channelId" = c\."id"\s+AND c\."threadId" LIKE 'legacy:%'\s+AND m\."status" IN \('invited', 'approved'\)/,
    );
    // Declined and already-left members keep their answer.
    expect(migrationSql).not.toMatch(/UPDATE "messaging_channel_members" SET "status" = 'left';/);
  });
});
