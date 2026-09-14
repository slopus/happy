import { describe, expect, it } from "vitest";
import { ApiUpdateSessionStateSchema, ApiUpdateNewSessionSchema } from "./apiTypes";

describe("optional session artwork on updates", () => {
  it("preserves chat state when optional artwork is malformed", () => {
    const metadata = { value: "encrypted metadata", version: 2 };
    const update = ApiUpdateSessionStateSchema.parse({
      t: "update-session",
      id: "s",
      metadata,
      avatar: { ref: "x", preview: "y", version: 0 },
      avatarVersion: "invalid",
    });
    expect(update.metadata).toEqual(metadata);
    expect(update.avatar).toBeUndefined();
    expect(update.avatarVersion).toBeUndefined();
  });
  it("preserves discovery when optional artwork is malformed", () => {
    const update = ApiUpdateNewSessionSchema.parse({
      t: "new-session",
      id: "s",
      createdAt: 1,
      updatedAt: 1,
      avatar: "invalid",
      avatarVersion: -1,
    });
    expect(update.id).toBe("s");
    expect(update.avatar).toBeUndefined();
    expect(update.avatarVersion).toBeUndefined();
  });
});
