import { McpServerConfigInput } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveMcpSlug } from "./mcp.js";

afterEach(() => vi.restoreAllMocks());

describe("deriveMcpSlug", () => {
  it.each([
    ["!_-_LOCAL!", "local"],
    [`${"_".repeat(80)}local`, "local"],
    ["9 Local", "9-local"],
    ["Local_MCP_", "local_mcp_"],
    ["Brex MCP Server!", "brex-mcp-server"],
    ["x".repeat(100), "x".repeat(64)],
  ])("derives a backend-valid slug for %j", (name, expected) => {
    const slug = deriveMcpSlug(name);

    expect(slug).toBe(expected);
    expect(
      McpServerConfigInput.safeParse({
        name: "Synthetic MCP server",
        slug,
        transport: "stdio",
        command: "demo",
      }).success,
    ).toBe(true);
  });

  it.each(["", "-_!-_", "世界"])(
    "uses a backend-valid fallback when %j has no slug characters",
    (name) => {
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const slug = deriveMcpSlug(name);

      expect(slug).toBe("mcp-1700000000000");
      expect(
        McpServerConfigInput.safeParse({
          name: "Synthetic MCP server",
          slug,
          transport: "stdio",
          command: "demo",
        }).success,
      ).toBe(true);
    },
  );

  it("preserves normalization collisions for the existing duplicate-server handling", () => {
    expect(deriveMcpSlug(" Local MCP ")).toBe(deriveMcpSlug("Local MCP!"));
  });
});
