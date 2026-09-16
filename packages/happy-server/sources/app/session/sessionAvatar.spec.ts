import { describe, expect, it } from "vitest";
import { sessionAvatar } from "./sessionAvatar";

describe("session avatar projection", () => {
  it("keeps project sessions and old records without artwork empty", () => {
    expect(sessionAvatar({})).toBeNull();
    expect(sessionAvatar({ avatarRef: null, avatarPreview: null, avatarVersion: 8 })).toBeNull();
  });
  it("returns the encrypted descriptor without exposing storage or plaintext", () => {
    expect(
      sessionAvatar({
        avatarRef: "sessions/s1/avatar/a.enc",
        avatarPreview: "ciphertext",
        avatarVersion: 3,
      }),
    ).toEqual({
      ref: "sessions/s1/avatar/a.enc",
      preview: "ciphertext",
      version: 3,
    });
  });
});
