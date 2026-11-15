import { describe, expect, it } from "vitest";
import { AccountExportRecordSchema } from "./account-export.js";
import { appContract } from "./index.js";
import {
  PAGE_SOURCE_MAX_BYTES,
  PAGE_TITLE_MAX_LENGTH,
  PageSourceSchema,
  PageSummarySchema,
  PageTitleSchema,
  SharedPageSchema,
} from "./pages.js";

describe("PageTitleSchema", () => {
  it("folds line breaks and control characters into single spaces", () => {
    expect(PageTitleSchema.parse("  Q3\nplan\r\n\tdraft\u0000 \u2028end ")).toBe(
      "Q3 plan draft end",
    );
  });

  it("refuses titles that are empty or too long once folded", () => {
    expect(PageTitleSchema.safeParse("\n\t\u0007").success).toBe(false);
    expect(PageTitleSchema.safeParse("x".repeat(PAGE_TITLE_MAX_LENGTH)).success).toBe(true);
    expect(PageTitleSchema.safeParse("x".repeat(PAGE_TITLE_MAX_LENGTH + 1)).success).toBe(false);
  });
});

it("bounds the titles pages send out by the cap a saved title has", () => {
  const at = "2026-11-02T10:00:00.000Z";
  const summary = (title: string) =>
    PageSummarySchema.safeParse({
      id: "page-1",
      title,
      botId: null,
      groupId: null,
      visibility: "private",
      currentVersion: 1,
      pinned: false,
      createdAt: at,
      updatedAt: at,
    }).success;
  const shared = (title: string) =>
    SharedPageSchema.safeParse({ title, code: "", version: 1, updatedAt: at }).success;
  const longest = "x".repeat(PAGE_TITLE_MAX_LENGTH);
  expect([summary(longest), shared(longest)]).toEqual([true, true]);
  expect([summary(`${longest}x`), shared(`${longest}x`)]).toEqual([false, false]);
});

describe("PageSourceSchema", () => {
  it("measures source in UTF-8 bytes, as the save check does", () => {
    expect(PageSourceSchema.safeParse("x".repeat(PAGE_SOURCE_MAX_BYTES)).success).toBe(true);
    expect(PageSourceSchema.safeParse("x".repeat(PAGE_SOURCE_MAX_BYTES + 1)).success).toBe(false);
    // Fewer characters than the limit, more bytes.
    expect(PageSourceSchema.safeParse("é".repeat(PAGE_SOURCE_MAX_BYTES / 2)).success).toBe(true);
    expect(PageSourceSchema.safeParse(`${"é".repeat(PAGE_SOURCE_MAX_BYTES / 2)}x`).success).toBe(
      false,
    );
  });
});

it("lets a newer client's reply from a page reach an older server, which drops what it does not know", () => {
  const send = appContract.threads.send["~orpc"].inputSchema!;
  // An older server's thread send is this object without fromPage: an unknown key is dropped, not refused.
  expect(send.parse({ botId: "bot-1", text: "hi", fromPage: true, notYetKnown: true })).toEqual({
    botId: "bot-1",
    text: "hi",
    fromPage: true,
  });
});

it("refuses an exported page version past the database's 32-bit column", () => {
  const record = (version: number) => ({
    type: "page_version",
    id: "src-page-v1",
    pageId: "src-page",
    version,
    title: "Plan",
    source: "export default () => null;",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  expect(AccountExportRecordSchema.safeParse(record(2_147_483_647)).success).toBe(true);
  expect(AccountExportRecordSchema.safeParse(record(2_147_483_648)).success).toBe(false);
});
