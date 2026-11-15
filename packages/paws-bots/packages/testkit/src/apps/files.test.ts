import { describe, expect, it } from "vitest";
import { fileId } from "./files.js";
import { studioFacts, studioFiles } from "./fixtures/studio.js";

const now = new Date("2026-11-06T16:30:00Z");
const ok = (result: ReturnType<ReturnType<typeof studioFiles>["call"]>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Record<string, any>;
};

describe("files emulator", () => {
  it("searches names and contents, ranking name matches and newest first", () => {
    const files = studioFiles({ now });
    const juniper = ok(files.call("search_files", { query: "juniper proposal" }));
    expect(juniper.files.map((f: { name: string }) => f.name)).toEqual([
      "Juniper Row – Lobby Proposal v3",
      "Juniper Row – Lobby Proposal v2",
    ]);
    expect(juniper.files[0]).toMatchObject({
      path: "/My files/Clients/Juniper Row Hotel",
      web_url: studioFacts(now).proposalV3Url,
      last_modified_by: "leo@haldenmoss.example",
    });
    expect(
      ok(files.call("search_files", { query: "walnut", type: "document" })).files,
    ).toHaveLength(1);
    expect(ok(files.call("search_files", { query: '"payment terms"' })).files[0].type).toBe("pdf");
    // A file the account cannot open never appears in search.
    expect(ok(files.call("search_files", { query: "FY2027" })).files).toEqual([]);
    // Operators the service lacks are refused, not ignored.
    for (const query of ["name:budget", "type:pdf", "walnut OR oak"]) {
      const refused = files.call("search_files", { query });
      expect(refused.ok ? null : refused.error.code).toBe("invalid_argument");
    }
  });

  it("lists folders with pagination", () => {
    const files = studioFiles({ now });
    const root = ok(files.call("list_folder", { page_size: 3 }));
    expect(root.files.map((f: { name: string }) => f.name)).toEqual([
      "Brand",
      "Clients",
      "Finance",
    ]);
    const rest = ok(files.call("list_folder", { page_size: 3, page_token: root.next_page_token }));
    expect(rest.files.map((f: { name: string }) => f.name)).toEqual([
      "Suppliers",
      "Templates",
      "Meeting notes – October 2026",
    ]);
    expect(rest.next_page_token).toBeNull();
  });

  it("reads documents and sheets by id or link, and reports sharing", () => {
    const files = studioFiles({ now });
    const v3 = ok(files.call("read_file", { file_id: studioFacts(now).proposalV3Url }));
    expect(v3.content).toContain("**41,250**");
    const sheet = ok(files.call("read_file", { file_id: fileId("budget-2026"), sheet: "Summary" }));
    expect(sheet.sheets[0].rows).toContainEqual(["Marketing", "64,000"]);
    const meta = ok(files.call("get_file_metadata", { file_id: fileId("juniper-proposal-v2") }));
    expect(meta.permissions).toContainEqual({
      email: "dana.whitfield@juniperrow.example",
      role: "commenter",
    });
    expect(meta.capabilities).toEqual({ can_edit: true, can_comment: true, can_share: true });
  });

  it("refuses files the account cannot open or edit", () => {
    const files = studioFiles({ now });
    const denied = files.call("read_file", { file_id: studioFacts(now).budget2027Id });
    expect(denied.ok ? null : denied.error).toMatchObject({
      code: "permission_denied",
      status: 403,
    });
    expect(denied.ok ? "" : denied.error.message).toContain("marta@haldenmoss.example");
    const readOnly = files.call("share_file", {
      file_id: fileId("budget-2026"),
      email: "a@b.example",
      role: "reader",
    });
    expect(readOnly.ok ? null : readOnly.error.code).toBe("permission_denied");
    const missing = files.call("get_file_metadata", { file_id: "1doesnotexist" });
    expect(missing.ok ? null : missing.error.code).toBe("not_found");
    expect(files.writes).toEqual([]);
  });

  it("records a share with before and after", () => {
    const files = studioFiles({ now });
    ok(
      files.call("share_file", {
        file_id: fileId("juniper-proposal-v3"),
        email: "dana.whitfield@juniperrow.example",
        role: "commenter",
      }),
    );
    expect(files.writes).toHaveLength(1);
    expect(files.writes[0]).toMatchObject({
      tool: "share_file",
      before: expect.not.arrayContaining([
        expect.objectContaining({ email: "dana.whitfield@juniperrow.example" }),
      ]),
      after: expect.arrayContaining([
        { email: "dana.whitfield@juniperrow.example", role: "commenter" },
      ]),
    });
  });
});
