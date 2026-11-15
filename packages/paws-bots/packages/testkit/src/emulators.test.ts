import { describe, expect, it } from "vitest";
import { DestinationEmulator, McpEmulator } from "./index.js";

describe("emulators", () => {
  it("writes destination state that an inspector can read", async () => {
    const dest = new DestinationEmulator();
    const ctx = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    for await (const event of dest.execute(
      {
        tool: "destination.write",
        args: { collection: "notes", title: "hello", body: "world" },
        executionId: "e1",
      },
      ctx,
    )) {
      expect(event.type).toBe("result");
    }
    expect(dest.records[0]?.title).toBe("hello");
  });

  it("records MCP writes independently of the model", async () => {
    const mcp = new McpEmulator();
    const port = await mcp.start();
    await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "tools/call",
        params: { name: "notes.write", arguments: { path: "a.md", text: "ok" } },
      }),
    });
    expect(mcp.inspect().writes[0]?.text).toBe("ok");
    await mcp.stop();
  });
});
