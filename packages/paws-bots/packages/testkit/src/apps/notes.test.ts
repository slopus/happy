import { describe, expect, it } from "vitest";
import { studioFacts, studioNotes } from "./fixtures/studio.js";
import { NotesEmulator, noteId } from "./notes.js";

const now = new Date("2026-11-06T16:30:00Z");
const ok = (result: ReturnType<ReturnType<typeof studioNotes>["call"]>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Record<string, any>;
};
const deliveries = noteId("deliveries");

describe("notes emulator", () => {
  it("searches titles and hides pages not shared with the connection", () => {
    const notes = studioNotes({ now });
    const found = ok(notes.call("search", { query: "deliveries" }));
    expect(found.results).toEqual([
      expect.objectContaining({ object: "database", id: deliveries, title: "Supplier deliveries" }),
    ]);
    expect(ok(notes.call("search", { query: "leadership" })).results).toEqual([]);
    const hidden = notes.call("read_page", { page_id: noteId("leadership") });
    expect(hidden.ok ? null : hidden.error.code).toBe("not_found");
  });

  it("hides everything under an unshared parent", () => {
    const notes = new NotesEmulator(
      {
        workspace: "W",
        baseUrl: "https://notes.example.com/w",
        member: "Sam",
        databases: [
          {
            key: "secret-db",
            title: "Secret db",
            access: "unshared",
            edited: now.toISOString(),
            properties: { Name: { type: "title" } },
          },
        ],
        pages: [
          { key: "secret", title: "Secret", access: "unshared", edited: now.toISOString() },
          { key: "child", title: "Secret child", parent: "secret", edited: now.toISOString() },
          { key: "row", title: "Secret row", parent: "secret-db", edited: now.toISOString() },
        ],
      },
      { now },
    );
    expect(ok(notes.call("search", { query: "secret" })).results).toEqual([]);
    for (const key of ["child", "row"]) {
      const read = notes.call("read_page", { page_id: noteId(key) });
      expect(read.ok ? null : read.error.code).toBe("not_found");
    }
    const edit = notes.call("update_page_properties", {
      page_id: noteId("row"),
      properties: { Name: "x" },
    });
    expect(edit.ok ? null : edit.error.code).toBe("not_found");
  });

  it("filters, sorts and paginates database rows", () => {
    const notes = studioNotes({ now });
    const schema = ok(notes.call("get_database", { database_id: deliveries }));
    expect(schema.properties.Status.options).toContain("Delayed");
    const first = ok(notes.call("list_database_rows", { database_id: deliveries }));
    expect(first.results).toHaveLength(10);
    expect(first.has_more).toBe(true);
    let all = first.results.length;
    let cursor = first.next_cursor;
    while (cursor) {
      const next = ok(
        notes.call("list_database_rows", { database_id: deliveries, start_cursor: cursor }),
      );
      all += next.results.length;
      cursor = next.next_cursor;
    }
    expect(all).toBe(25);
    const open = ok(
      notes.call("list_database_rows", {
        database_id: deliveries,
        filter: {
          and: [
            { property: "Status", condition: "does_not_equal", value: "Delivered" },
            { property: "Status", condition: "does_not_equal", value: "Cancelled" },
          ],
        },
        sorts: [{ property: "PO", direction: "ascending" }],
      }),
    );
    expect(open.results.map((r: { properties: { PO: string } }) => r.properties.PO)).toEqual([
      "PO-4465",
      "PO-4471",
      "PO-4476",
      "PO-4480",
      "PO-4483",
    ]);
    const bad = notes.call("list_database_rows", {
      database_id: deliveries,
      filter: { property: "State", condition: "equals", value: "x" },
    });
    expect(bad.ok ? null : bad.error.message).toMatch(/Could not find property State/);
  });

  it("validates and records property updates", () => {
    const notes = studioNotes({ now });
    const row = noteId("delivery-PO-4471");
    const invalid = notes.call("update_page_properties", {
      page_id: row,
      properties: { Status: "Late" },
    });
    expect(invalid.ok ? null : invalid.error.message).toMatch(/"Late" is not an option for Status/);
    const badDate = notes.call("update_page_properties", {
      page_id: row,
      properties: { ETA: "next Thursday" },
    });
    expect(badDate.ok ? null : badDate.error.code).toBe("invalid_argument");
    const impossible = notes.call("update_page_properties", {
      page_id: row,
      properties: { ETA: "2026-02-30" },
    });
    expect(impossible.ok ? null : impossible.error.code).toBe("invalid_argument");
    const badPeople = notes.call("update_page_properties", {
      page_id: row,
      properties: { Owner: [42] },
    });
    expect(badPeople.ok ? null : badPeople.error.code).toBe("invalid_argument");
    const eta = studioFacts(now).ostravaNewEta;
    ok(
      notes.call("update_page_properties", {
        page_id: row,
        properties: { Status: "Delayed", ETA: eta },
      }),
    );
    expect(notes.writes).toHaveLength(1);
    expect(notes.writes[0]).toMatchObject({
      target: row,
      before: { Status: "In transit" },
      after: { Status: "Delayed", ETA: eta, PO: "PO-4471" },
    });
    // A same-day date-time matches date filters for that day.
    ok(
      notes.call("update_page_properties", {
        page_id: row,
        properties: { ETA: `${eta}T09:00:00Z` },
      }),
    );
    for (const condition of ["equals", "on_or_before", "on_or_after"]) {
      const rows = ok(
        notes.call("list_database_rows", {
          database_id: deliveries,
          filter: { property: "ETA", condition, value: eta },
        }),
      ).results.map((r: { properties: { PO: string } }) => r.properties.PO);
      expect(rows).toContain("PO-4471");
    }
  });

  it("reads page blocks, creates rows and pages, and refuses view-only pages", () => {
    const notes = studioNotes({ now });
    const sync = ok(notes.call("read_page", { page_id: noteId("ops-sync") }));
    expect(sync.blocks.map((b: { type: string }) => b.type)).toContain("to_do");
    const created = ok(
      notes.call("create_page", {
        database_id: deliveries,
        title: "PO-4490 · Pendant shades",
        properties: { PO: "PO-4490", Status: "Ordered", Supplier: "Brightline Lighting" },
      }),
    );
    expect(created.parent).toMatchObject({ type: "database", title: "Supplier deliveries" });
    const viewOnly = notes.call("create_page", {
      parent_page_id: noteId("pricing-policy"),
      title: "Edit",
    });
    expect(viewOnly.ok ? null : viewOnly.error.code).toBe("permission_denied");
    const cleared = ok(
      notes.call("update_page_properties", { page_id: created.id, properties: { Order: null } }),
    );
    expect(cleared.properties.Order).toBeNull();
    expect(ok(notes.call("search", { query: "PO-4490" })).results).toEqual([]);
    expect(notes.writes.map((w) => w.tool)).toEqual(["create_page", "update_page_properties"]);
  });
});
