import { describe, expect, it } from "vitest";
import { helperResultText } from "./pi-runtime-subagent.js";

const limit = 100;

describe("helper result text", () => {
  it("keeps a short result unchanged", () => {
    expect(helperResultText("done.", undefined, limit)).toBe("done.");
    expect(helperResultText("Checked.", "Stopped.", limit)).toBe("Checked.\n\nStopped.");
  });

  it("clips a long result without a stop text to the limit", () => {
    const text = helperResultText("x".repeat(500), undefined, limit);
    expect(text).toHaveLength(limit);
    expect(text.endsWith("…")).toBe(true);
  });

  it("keeps the whole stop text and shortens only the narration before it", () => {
    const text = helperResultText("x".repeat(500), "Stopped here.", limit);
    expect(text.length).toBeLessThanOrEqual(limit);
    expect(text.endsWith("\n\nStopped here.")).toBe(true);
  });

  it("clips a stop text longer than the limit to the limit", () => {
    const text = helperResultText("x".repeat(50), "y".repeat(500), limit);
    expect(text).toHaveLength(limit);
    expect(text.startsWith("yyy")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
  });

  it("returns the stop text alone when it leaves no room for narration", () => {
    expect(helperResultText("x".repeat(50), "y".repeat(99), limit)).toBe("y".repeat(99));
  });
});
