import { describe, expect, it } from "vitest";
import { readBoundedBytes } from "./http-body.js";

function streamed(chunks: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://test/", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

describe("readBoundedBytes", () => {
  it("reads a body with or without a declared length", async () => {
    expect(
      text(await readBoundedBytes(streamed(["ab", "cd"], { "content-length": "4" }), 10)),
    ).toBe("abcd");
    expect(text(await readBoundedBytes(streamed(["ab", "cd"]), 10))).toBe("abcd");
  });

  it("keeps every byte of a body longer or shorter than it declared", async () => {
    expect(
      text(await readBoundedBytes(streamed(["ab", "cd", "ef"], { "content-length": "3" }), 10)),
    ).toBe("abcdef");
    expect(text(await readBoundedBytes(streamed(["ab"], { "content-length": "5" }), 10))).toBe(
      "ab",
    );
  });

  it("refuses a body over the limit, declared or not", async () => {
    expect(await readBoundedBytes(streamed(["abc"], { "content-length": "11" }), 10)).toBeNull();
    expect(await readBoundedBytes(streamed(["abcdef", "ghijk"]), 10)).toBeNull();
  });
});
