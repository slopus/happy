import { describe, expect, it } from "vitest";
import {
  pawsSessionTools,
  callPawsSessionTool,
  pawsSessionSchemas,
} from "./paws-session-tools.js";
describe("Paws session tools", () => {
  it("exposes bounded schemas for every required operation", () => {
    expect(pawsSessionTools.map((t) => t.name)).toEqual([
      "paws_sessions_list",
      "paws_session_read",
      "paws_session_send",
      "paws_session_resume",
      "paws_session_result",
    ]);
    expect(
      pawsSessionSchemas.paws_session_send.safeParse({
        sessionId: "s",
        connectionId: "connection",
        text: "continue",
      }).success,
    ).toBe(true);
    expect(
      pawsSessionSchemas.paws_session_send.safeParse({
        sessionId: "s",
        connectionId: "connection",
        text: "continue",
        chiefId: "other",
      }).success,
    ).toBe(false);
  });
  it("refuses missing server configuration without attempting a request", async () => {
    await expect(
      callPawsSessionTool(
        {
          chiefId: "c",
          spaceId: "s",
          id: "r",
          tool: "paws_sessions_list",
          args: {},
        },
        new AbortController().signal,
        {},
      ),
    ).rejects.toThrow("not-configured");
  });
});

it("does not offer Web session tools to ordinary runs or non-owner surfaces", async () => {
  const { selectBuiltinToolsForRun } = await import("./run-tool-selection.js");
  const options = {
    graphicalToolsAllowed: false,
    groupId: null,
    trigger: "user",
    semanticMemoryEnabled: false,
    messagingChannelRun: false,
  };
  expect(
    selectBuiltinToolsForRun(options).some((t) =>
      t.name.startsWith("paws_session"),
    ),
  ).toBe(false);
  expect(
    selectBuiltinToolsForRun({ ...options, pawsSessions: true }).filter((t) =>
      t.name.startsWith("paws_session"),
    ),
  ).toHaveLength(5);
  expect(
    selectBuiltinToolsForRun({
      ...options,
      pawsSessions: true,
      groupId: "group",
    }).some((t) => t.name.startsWith("paws_session")),
  ).toBe(false);
  expect(
    selectBuiltinToolsForRun({
      ...options,
      pawsSessions: true,
      trigger: "routine",
    }).some((t) => t.name.startsWith("paws_session")),
  ).toBe(false);
});

it("uses the existing approval policy for writes and treats other conversation contents as untrusted", async () => {
  const { toolRequiresApproval, toolResultTaintsRun } =
    await import("@rakazo/core");
  expect(toolRequiresApproval("paws_session_send", false)).toBe(true);
  expect(toolRequiresApproval("paws_session_resume", false)).toBe(true);
  expect(toolRequiresApproval("paws_session_read", false)).toBe(false);
  expect(toolResultTaintsRun("paws_session_read")).toBe(true);
});

it.each([
  { owner: undefined, groupId: null, botId: "c" + "a".repeat(24) },
  { owner: "someone-else", groupId: null, botId: "c" + "a".repeat(24) },
  { owner: "owner", groupId: "group", botId: "c" + "a".repeat(24) },
  { owner: "owner", groupId: null, botId: "helper" },
])(
  "refuses execution outside the owning chief direct conversation (%j)",
  async ({ owner, groupId, botId }) => {
    const { pawsSessionHandlers } = await import("./paws-session-tools.js");
    const ctx = {
      source: { userComputerOwner: owner },
      run: { userId: "owner" },
      thread: { groupId },
      bot: { id: botId },
    };
    const call = { finish: async (value: unknown) => value };
    expect(
      await pawsSessionHandlers.paws_session_send!(ctx as any, call as any),
    ).toEqual({ error: "paws-session-tools-owner-only" });
  },
);

it("keeps the routing nonce and session identifier in the actual model parameter schema", async () => {
  const { parametersFor } = await import("./pi-runtime-tool-parameters.js");
  const tool = pawsSessionTools.find(
    (tool) => tool.name === "paws_session_send",
  )!;
  const schema = parametersFor(tool) as unknown as {
    properties: Record<string, unknown>;
    required: string[];
  };
  expect(schema.required).toEqual(
    expect.arrayContaining(["sessionId", "connectionId", "text"]),
  );
  expect(schema.properties.connectionId).toMatchObject({ type: "string" });
});
