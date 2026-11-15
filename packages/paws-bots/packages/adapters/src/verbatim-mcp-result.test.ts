import { describe, expect, it } from "vitest";
import { isVerbatimMcpResult } from "./verbatim-mcp-result.js";

const servers = { ids: ["srv_mail"], slugs: ["mail__inbox"] };
const execute = (id: string) => isVerbatimMcpResult("connectors_execute_tool", { id }, servers);

describe("verbatim MCP results", () => {
  it("matches a direct MCP tool by its server slug, even one containing __", () => {
    expect(isVerbatimMcpResult("mcp__mail__inbox__get_message", {}, servers)).toBe(true);
    expect(isVerbatimMcpResult("mcp__mail__get_message", {}, servers)).toBe(false);
    expect(isVerbatimMcpResult("mcp__mail__inbox__get_message", {}, undefined)).toBe(false);
  });

  it("matches every catalog id form that names the server", () => {
    expect(execute("srv_mail:get_message")).toBe(true);
    expect(execute("mail__inbox:get_message")).toBe(true);
    expect(execute("Mail__Inbox/get_message")).toBe(true);
    expect(execute("mcp__mail__inbox__get_message")).toBe(true);
    expect(execute("srv_docs:search")).toBe(false);
    expect(
      isVerbatimMcpResult("installed_execute_tool", { id: "srv_mail:get_message" }, servers),
    ).toBe(false);
  });
});
