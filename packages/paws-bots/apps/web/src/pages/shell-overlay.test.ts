import { describe, expect, it } from "vitest";
import {
  readShellOverlay,
  searchString,
  shellOverlaySearch,
  withShellOverlay,
} from "./shell-overlay";

const read = (search: string) => readShellOverlay(new URLSearchParams(search));

describe("readShellOverlay", () => {
  it("opens nothing without overlay params", () => {
    expect(read("")).toBeNull();
    expect(read("?m=msg_1&routine=r_1")).toBeNull();
  });

  it("opens a settings section, falling back to general for bare or unknown values", () => {
    expect(read("?settings=voice")).toEqual({ kind: "settings", section: "voice", spaceId: null });
    expect(read("?settings=space&space=sp_1")).toEqual({
      kind: "settings",
      section: "space",
      spaceId: "sp_1",
    });
    expect(read("?settings")).toEqual({ kind: "settings", section: "general", spaceId: null });
    expect(read("?settings=nope")).toEqual({ kind: "settings", section: "general", spaceId: null });
  });

  it("binds settings to a space only alongside settings", () => {
    expect(read("?settings=models&space=sp_1")).toEqual({
      kind: "settings",
      section: "models",
      spaceId: "sp_1",
    });
    expect(read("?space=sp_1")).toBeNull();
  });

  it("reads flag overlays with or without a value", () => {
    expect(read("?integrations")).toEqual({ kind: "integrations" });
    expect(read("?mcp=")).toEqual({ kind: "mcp" });
    expect(read("?mcp=srv_1")).toEqual({ kind: "mcp", serverId: "srv_1" });
  });

  it("opens Messaging settings from the old messaging link", () => {
    expect(read("?messaging")).toEqual({ kind: "settings", section: "messaging", spaceId: null });
  });
});

describe("withShellOverlay", () => {
  const write = (search: string, overlay: Parameters<typeof withShellOverlay>[1]) =>
    searchString(withShellOverlay(new URLSearchParams(search), overlay));

  it("keeps unrelated params and writes flags bare", () => {
    expect(write("?m=msg_1", { kind: "integrations" })).toBe("?m=msg_1&integrations");
  });

  it("replaces the open overlay instead of stacking another", () => {
    expect(write("?integrations&routine=r_1", { kind: "mcp" })).toBe("?routine=r_1&mcp");
    expect(write("", { kind: "mcp", serverId: "srv_1" })).toBe("?mcp=srv_1");
    expect(write("?settings=models&space=sp_1", { kind: "integrations" })).toBe("?integrations");
  });

  it("writes the settings section and space", () => {
    expect(write("", { kind: "settings", section: "models", spaceId: "sp_1" })).toBe(
      "?settings=models&space=sp_1",
    );
    expect(write("?space=sp_1", { kind: "settings", section: "usage", spaceId: null })).toBe(
      "?settings=usage",
    );
  });

  it("closing removes only overlay params", () => {
    expect(write("?m=msg_1&settings=voice&space=sp_1", null)).toBe("?m=msg_1");
    expect(write("?mcp", null)).toBe("");
  });

  it("round-trips through readShellOverlay", () => {
    const overlay = { kind: "settings", section: "billing", spaceId: "sp_2" } as const;
    expect(readShellOverlay(withShellOverlay(new URLSearchParams(), overlay))).toEqual(overlay);
  });
});

describe("shellOverlaySearch", () => {
  it("carries only the overlay into a redirect", () => {
    expect(shellOverlaySearch(new URLSearchParams("?m=msg_1&settings=voice"))).toBe(
      "?settings=voice",
    );
    expect(shellOverlaySearch(new URLSearchParams("?routine=r_1"))).toBe("");
  });
});
