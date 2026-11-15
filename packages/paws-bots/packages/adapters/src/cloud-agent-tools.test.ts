import { toolRequiresApproval } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { validCloudAgentArgs } from "./cloud-agent-tools.js";
import { CLOUD_AGENT_TOOL_NAMES, selectCloudAgentTools } from "./cloud-agent-tools-select.js";

describe("cloud agent tool boundary", () => {
  it("hides every cloud tool when no provider is authorized", () => {
    expect(
      selectCloudAgentTools(builtinAgentTools, false).some((tool) =>
        CLOUD_AGENT_TOOL_NAMES.has(tool.name),
      ),
    ).toBe(false);
    expect(selectCloudAgentTools(builtinAgentTools, true)).toBe(builtinAgentTools);
  });
  it("keeps only status and cancellation for existing agents without launch access", () => {
    expect(
      selectCloudAgentTools(builtinAgentTools, false, true)
        .filter((tool) => CLOUD_AGENT_TOOL_NAMES.has(tool.name))
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["cloud_agent_cancel", "cloud_agent_status"]);
  });
  it("classifies every mutation as consequential", () => {
    for (const name of ["cloud_agent_launch", "cloud_agent_reply", "cloud_agent_cancel"])
      expect(toolRequiresApproval(name, false)).toBe(true);
    expect(toolRequiresApproval("cloud_agent_status", false)).toBe(false);
  });
  it("rejects raw environment variables and malformed arguments before effect persistence", () => {
    for (const args of [
      { prompt: "Task", environment: { TOKEN: "fake-secret" } },
      { prompt: "" },
      { prompt: "Task", openPr: "false" },
      { prompt: "Task", images: [{ url: "http://example.test/image.png" }] },
      { prompt: "Task", images: [{ url: "https://user:password@example.test/image.png" }] },
    ]) {
      expect(validCloudAgentArgs("cloud_agent_launch", args)).toBe(false);
    }
    expect(validCloudAgentArgs("cloud_agent_launch", { prompt: "Task", openPr: false })).toBe(true);
    expect(validCloudAgentArgs("cloud_agent_reply", { id: "agent", prompt: "Tests" })).toBe(true);
    expect(validCloudAgentArgs("cloud_agent_cancel", { id: "" })).toBe(false);
  });
});
