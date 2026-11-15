import { describe, expect, it } from "vitest";
import { encodeTerminalInput, encodeTerminalResize } from "./terminal.js";

describe("terminal framing", () => {
  it("prefixes input with its kind and byte length", () => {
    expect([...encodeTerminalInput("é")]).toEqual([0, 0, 0, 0, 2, 0xc3, 0xa9]);
  });

  it("clamps resize dimensions", () => {
    expect([...encodeTerminalResize(0, 5000)]).toEqual([1, 0, 0, 0, 4, 0, 1, 0x03, 0xe8]);
  });
});
