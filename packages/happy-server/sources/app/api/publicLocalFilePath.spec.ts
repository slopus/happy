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
});
