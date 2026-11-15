import { describe, expect, it, vi } from "vitest";
import { AGENT_DOCUMENT_MAX_BYTES, readAgentDocument } from "./agent-document";

describe("a chosen agent document", () => {
  it("is refused unread when it is too large", async () => {
    const text = vi.fn(async () => "never");
    expect(await readAgentDocument({ size: AGENT_DOCUMENT_MAX_BYTES + 1, text })).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it("is read when it fits", async () => {
    const text = vi.fn(async () => "# Name\nAtlas\n");
    expect(await readAgentDocument({ size: 14, text })).toBe("# Name\nAtlas\n");
  });
});
