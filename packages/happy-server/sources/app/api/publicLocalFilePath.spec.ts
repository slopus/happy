import { describe, expect, it } from "vitest";
import { publicLocalFilePath } from "./publicLocalFilePath";

describe("public local files", () => {
  it("does not bypass avatar authentication through the static files route", () => {
    expect(publicLocalFilePath("/data/files", "sessions/s1/avatar/a.enc")).toBeNull();
    expect(publicLocalFilePath("/data/files", "public/../sessions/s1/avatar/a.enc")).toBeNull();
    expect(publicLocalFilePath("/data/files", "../private")).toBeNull();
    expect(publicLocalFilePath("/data/files", "public/avatar.webp")).toBe(
      "/data/files/public/avatar.webp",
    );
  });

  it("refuses every namespace the deny-list did not enumerate", () => {
    // Session attachments and project avatars have authenticated routes of
    // their own that check ownership; the static route used to serve the same
    // bytes to anyone who knew the path.
    expect(publicLocalFilePath("/data/files", "sessions/s1/attachments/a.enc")).toBeNull();
    expect(publicLocalFilePath("/data/files", "projects/p1/avatar/a.enc")).toBeNull();
    // A namespace nobody has added yet is refused by default rather than served.
    expect(publicLocalFilePath("/data/files", "exports/backup.tar")).toBeNull();
  });

  it("refuses a session avatar whose path differs only in case", () => {
    // On a case-insensitive filesystem the single deny-list rule missed this
    // spelling while the open() that followed still resolved the same file.
    expect(publicLocalFilePath("/data/files", "sessions/s1/AVATAR/a.enc")).toBeNull();
    expect(publicLocalFilePath("/data/files", "Sessions/s1/avatar/a.enc")).toBeNull();
  });

  it("still serves the namespace uploadImage writes", () => {
    expect(publicLocalFilePath("/data/files", "public/users/u1/avatars/a.webp")).toBe(
      "/data/files/public/users/u1/avatars/a.webp",
    );
  });
});
