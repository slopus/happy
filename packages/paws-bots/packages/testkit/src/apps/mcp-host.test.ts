import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { studioFiles } from "./fixtures/studio.js";
import { hostOverMcp } from "./mcp-host.js";

const now = new Date("2026-11-06T16:30:00Z");
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("emulators over MCP", () => {
  it("serves tools with read-only hints and tool errors to a standard MCP client", async () => {
    const files = studioFiles({ now });
    const hosted = await hostOverMcp(files, "test-token");
    closers.push(hosted.close);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(hosted.endpoint), {
        requestInit: { headers: { authorization: "Bearer test-token" } },
      }),
    );
    closers.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "search_files")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "share_file")?.annotations?.readOnlyHint).toBe(false);

    const found = await client.callTool({ name: "search_files", arguments: { query: "walnut" } });
    const text = (found.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).files[0].name).toBe("Juniper Row – Lobby Proposal v3");

    const denied = await client.callTool({ name: "read_file", arguments: { file_id: "1nothing" } });
    expect(denied.isError).toBe(true);
    expect(files.calls.map((call) => call.tool)).toEqual(["search_files", "read_file"]);
  });

  it("rejects requests without the bearer token", async () => {
    const hosted = await hostOverMcp(studioFiles({ now }), "test-token");
    closers.push(hosted.close);
    const response = await fetch(hosted.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
