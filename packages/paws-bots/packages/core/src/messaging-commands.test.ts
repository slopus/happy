import { describe, expect, it } from "vitest";
import { parseMessagingCommand } from "./messaging-commands.js";

describe("parseMessagingCommand", () => {
  it("parses the minimal command set case-insensitively", () => {
    expect(parseMessagingCommand("YES")).toBe("approve");
    expect(parseMessagingCommand("yes")).toBe("approve");
    expect(parseMessagingCommand(" yes ")).toBe("approve");
    expect(parseMessagingCommand("NO")).toBe("decline");
    expect(parseMessagingCommand("no")).toBe("decline");
    expect(parseMessagingCommand("LEAVE")).toBe("leave");
    expect(parseMessagingCommand("leave")).toBe("leave");
  });

  it("reads a bare stop or stop now, ignoring case, spacing and closing punctuation", () => {
    for (const text of ["stop", "Stop now.", "STOP!", "  stop   now ", "stop…"])
      expect(parseMessagingCommand(text)).toBe("stop");
    for (const text of [
      "Stopp!",
      "detente",
      "¡Detente!",
      "Стоп",
      "停止。",
      "停下！",
      "przestań",
      "Arrête !",
      "pare",
      "멈춰",
      "Dur.",
      "रुको",
      "עצור",
    ])
      expect(parseMessagingCommand(text)).toBe("stop");
    for (const text of ["para", "¿Para?", "stop it", "stopper", "don't stop", "/stop", "stop, now"])
      expect(parseMessagingCommand(text)).toBeNull();
  });

  it("treats everything else as a normal message", () => {
    expect(parseMessagingCommand("yes please")).toBeNull();
    expect(parseMessagingCommand("YES!")).toBeNull();
    expect(parseMessagingCommand("")).toBeNull();
    expect(parseMessagingCommand("hello")).toBeNull();
    expect(parseMessagingCommand("leave the group")).toBeNull();
  });
});
