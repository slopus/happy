import type { ConnectorTool } from "@rakazo/adapter-kit";
import { APPROVED_ACTION_NOT_RUN_ERROR } from "@rakazo/core";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it } from "vitest";
import {
  approvalReplayResourceError,
  approvedCatalogReplay,
  approvedReplayArgs,
  boundDirectApprovalRequest,
  catalogApprovalRequest,
  createApprovedEffectReplayQueue,
} from "./approval-effect.js";
import {
  catalogEntries,
  disambiguateInstalledToolNames,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import {
  APPROVED_EFFECT_REPLAY_ORDER,
  approvalReplayEffectToolName,
  buildApprovalContinuation,
} from "./run-effects.js";

describe("executor approval replay", () => {
  it.each([
    ["MCP", "install-mcp", "notes.write"],
    ["API", "install-api", "createContact"],
  ])("replays a pre-namespaced installed %s approval", (_kind, resourceId, toolName) => {
    const [tool] = disambiguateInstalledToolNames([
      {
        name: toolName,
        description: toolName,
        inputSchema: { type: "object" },
        route: { connectorId: "installed", resourceId, toolName },
      },
    ]);
    const request = catalogApprovalRequest(
      "installed_execute_tool",
      { id: `${resourceId}:${toolName}`, arguments: {} },
      "__rakazoCatalogTool",
    );
    const queue = createApprovedEffectReplayQueue([{ kind: toolName, request }]);

    expect(tool!.name).toBe(toolName);
    expect(queue.take(tool!.name)).toEqual(request);
    expect(queue.assertDrained).not.toThrow();
  });

  it("lists and replays every approved request in FIFO order when a tool repeats", () => {
    const effects = [
      { kind: "destination.write", request: { sequence: 1 } },
      { kind: "destination.write", request: { sequence: 2 } },
    ];

    const continuation = buildApprovalContinuation(effects, JSON.stringify);
    expect(continuation).toContain(
      "Call each listed approved request exactly once, in the listed order",
    );
    expect(continuation?.indexOf('{"sequence":1}')).toBeLessThan(
      continuation?.indexOf('{"sequence":2}') ?? -1,
    );

    const queue = createApprovedEffectReplayQueue(effects);
    expect(queue.take("destination.write")).toEqual({ sequence: 1 });
    expect(queue.assertDrained).toThrow(APPROVED_ACTION_NOT_RUN_ERROR);
    expect(queue.take("destination.write")).toEqual({ sequence: 2 });
    expect(queue.take("destination.write")).toBeUndefined();
    expect(queue.assertDrained).not.toThrow();
  });

  it("uses a stable secondary key when approval timestamps match", () => {
    expect(APPROVED_EFFECT_REPLAY_ORDER).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("replays an approved lazy tool through the exposed catalog executor", () => {
    const continuation = buildApprovalContinuation(
      [
        {
          kind: "mcp__demo__send_message",
          request: catalogApprovalRequest(
            "connectors_execute_tool",
            { id: "server-1:send_message", arguments: { text: "approved exactly" } },
            "__rakazoCatalogTool",
          ),
        },
      ],
      JSON.stringify,
    );

    expect(continuation).toContain(
      'connectors_execute_tool: {"id":"server-1:send_message","arguments":{"text":"approved exactly"}}',
    );
    expect(continuation).not.toContain("__rakazoCatalogTool");
  });

  it("renders a direct tool continuation when a catalog approval's wrapper is no longer exposed", () => {
    const request = catalogApprovalRequest(
      "installed_execute_tool",
      { id: "install-A:notes.write", arguments: { text: "approved exactly" } },
      "__rakazoCatalogTool",
    );
    const stillCatalog = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["installed_execute_tool", "installed_search_tools"]) },
    );
    const afterShrink = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["notes.write"]) },
    );
    const afterShrinkUniquified = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["installed__install-A__notes.write"]) },
    );

    expect(stillCatalog).toContain(
      'installed_execute_tool: {"id":"install-A:notes.write","arguments":{"text":"approved exactly"}}',
    );
    expect(afterShrink).toContain('notes.write: {"text":"approved exactly"}');
    expect(afterShrink).not.toContain("installed_execute_tool:");
    expect(afterShrinkUniquified).toContain(
      'installed__install-A__notes.write: {"text":"approved exactly"}',
    );
  });

  it("replays an approved deferred built-in through use_tool", () => {
    const continuation = buildApprovalContinuation(
      [{ kind: "create_space", request: { name: "Finance" } }],
      JSON.stringify,
      { exposedToolNames: new Set(["shell", "find_tool", "use_tool"]) },
    );
    expect(continuation).toContain(
      'use_tool: {"name":"create_space","arguments":{"name":"Finance"}}',
    );
  });

  it("keeps a direct-tool argument named like the catalog marker in continuation JSON", () => {
    const continuation = buildApprovalContinuation(
      [
        {
          kind: "notes.write",
          request: {
            id: "row-1",
            arguments: { mode: "strict" },
            text: "approved exactly",
            __rakazoCatalogTool: "installed_execute_tool",
          },
        },
      ],
      JSON.stringify,
    );

    expect(continuation).toContain(
      'notes.write: {"id":"row-1","arguments":{"mode":"strict"},"text":"approved exactly","__rakazoCatalogTool":"installed_execute_tool"}',
    );
  });

  it("renders a catalog wrapper continuation when a bound direct tool is no longer exposed", () => {
    const request = boundDirectApprovalRequest(
      { connectorId: "installed", resourceId: "install-A", toolName: "notes.write" },
      { text: "approved exactly" },
      "__rakazoCatalogTool",
    );
    const stillDirect = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["notes.write"]) },
    );
    const afterGrowth = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["installed_execute_tool"]) },
    );

    expect(stillDirect).toContain('notes.write: {"text":"approved exactly"}');
    expect(afterGrowth).toContain(
      'installed_execute_tool: {"id":"install-A:notes.write","arguments":{"text":"approved exactly"}}',
    );
    expect(afterGrowth).not.toContain("notes.write:");
  });

  it("keeps the selected connection in a continuation when account tools move into the catalog", () => {
    const request = boundDirectApprovalRequest(
      { connectorId: "example", resourceId: "mail", toolName: "send", connectionId: "work" },
      { text: "approved exactly" },
      "__rakazoCatalogTool",
    );
    const continuation = buildApprovalContinuation(
      [{ kind: "send_scoped", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["example_execute_tool"]) },
    );
    expect(continuation).toContain('"id":"mail:work:send"');
  });

  it("renders a catalog wrapper continuation when a bound MCP tool is no longer exposed", () => {
    const request = boundDirectApprovalRequest(
      { connectorId: "mcp", resourceId: "server-1", toolName: "send_message" },
      { text: "approved exactly" },
      "__rakazoCatalogTool",
    );
    const afterGrowth = buildApprovalContinuation(
      [{ kind: "mcp__demo__send_message", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["connectors_execute_tool"]) },
    );

    expect(afterGrowth).toContain(
      'connectors_execute_tool: {"id":"server-1:send_message","arguments":{"text":"approved exactly"}}',
    );
    expect(afterGrowth).not.toContain("mcp__demo__send_message:");
    expect(afterGrowth).not.toContain("mcp_execute_tool:");
  });

  it("resumes a legacy mcp_execute_tool envelope as connectors_execute_tool when that wrapper is exposed", () => {
    const route = {
      connectorId: "mcp",
      resourceId: "server-1",
      toolName: "send_message",
      resourceRevision: 2,
    };
    const request = catalogApprovalRequest(
      "mcp_execute_tool",
      { id: "server-1:send_message", arguments: { text: "approved exactly" } },
      "__rakazoCatalogTool",
      route,
    );
    const continuation = buildApprovalContinuation(
      [{ kind: "mcp__demo__send_message", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["connectors_execute_tool"]) },
    );

    expect(continuation).toContain(
      'connectors_execute_tool: {"id":"server-1:send_message","arguments":{"text":"approved exactly"}}',
    );
    expect(continuation).not.toContain("mcp_execute_tool:");
    const queue = createApprovedEffectReplayQueue([{ kind: "mcp__demo__send_message", request }]);
    const replay = approvedCatalogReplay(
      queue,
      "connectors_execute_tool",
      "__rakazoCatalogTool",
      true,
    );
    expect(replay.error).toBeUndefined();
    expect(replay.args).toEqual({
      id: "server-1:send_message",
      arguments: { text: "approved exactly" },
    });
    const resolved = resolveCatalogCall(
      {
        tool: "connectors_execute_tool",
        args: replay.args!,
        executionId: "approved",
        route: { connectorId: "mcp", toolName: "__catalog_execute" },
      },
      catalogEntries([
        {
          name: "mcp__demo__send_message",
          description: "Send a message",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          route,
        },
      ]),
    );
    expect(resolved.call.args).toEqual({ text: "approved exactly" });
    expect(resolved.tool.route).toEqual(route);
    expect(
      approvalReplayResourceError(resolved.tool.name, true, request, route, "__rakazoCatalogTool"),
    ).toBeUndefined();
    expect(
      approvalReplayResourceError(
        resolved.tool.name,
        true,
        request,
        { ...route, resourceRevision: 3 },
        "__rakazoCatalogTool",
      ),
    ).toContain("different connector resource");
    expect(
      approvalReplayResourceError(
        resolved.tool.name,
        true,
        request,
        { ...route, resourceId: "server-2" },
        "__rakazoCatalogTool",
      ),
    ).toContain("different connector resource");
    expect(
      approvedReplayArgs(queue.take(resolved.tool.name), resolved.call.args, "__rakazoCatalogTool"),
    ).toEqual({ text: "approved exactly" });
    expect(queue.assertDrained).not.toThrow();
  });

  it.each([
    ["mcp_execute_tool", "installed_execute_tool"],
    ["installed_execute_tool", "connectors_execute_tool"],
    ["connectors_execute_tool", "mcp_execute_tool"],
  ])("does not alias approval %s to unrelated wrapper %s", (stored, called) => {
    const request = catalogApprovalRequest(
      stored,
      { id: "server-1:send_message", arguments: {} },
      "__rakazoCatalogTool",
    );
    const queue = createApprovedEffectReplayQueue([{ kind: "mcp__demo__send_message", request }]);
    expect(approvedCatalogReplay(queue, called, "__rakazoCatalogTool", true).error).toContain(
      "must be replayed before",
    );
    expect(queue.nextRequest()).toBe(request);
    expect(
      approvedCatalogReplay(queue, "connectors_execute_tool", "__rakazoCatalogTool", false),
    ).toEqual({});
  });

  it("renders a uniquified direct name when collision renames the tool under the direct limit", () => {
    const request = boundDirectApprovalRequest(
      { connectorId: "installed", resourceId: "install-A", toolName: "delete_item" },
      { target: "approved" },
      "__rakazoCatalogTool",
    );
    const continuation = buildApprovalContinuation(
      [{ kind: "delete_item", request }],
      JSON.stringify,
      {
        exposedToolNames: new Set([
          "installed__install-A__delete_item",
          "installed__install-B__delete_item",
        ]),
      },
    );

    expect(continuation).toContain('installed__install-A__delete_item: {"target":"approved"}');
    expect(continuation).not.toContain("installed_execute_tool:");
    expect(continuation).not.toMatch(/(^|\n)delete_item:/);
  });

  it("keeps the original approval effect key after collision uniquify", () => {
    const args = { target: "approved" };
    const original = approvalEffectKey("run", "delete_item", args);
    const uniquified = approvalEffectKey("run", "installed__install-A__delete_item", args);
    expect(original).not.toBe(uniquified);
    const replayName = approvalReplayEffectToolName(
      "installed__install-A__delete_item",
      "delete_item",
      true,
    );
    expect(approvalEffectKey("run", replayName, args)).toBe(original);
  });

  it("pins lazy approval replay to the approved source when tool names collide", () => {
    const effects = [
      {
        kind: "delete_item",
        request: catalogApprovalRequest(
          "installed_execute_tool",
          { id: "install-A:delete_item", arguments: { target: "approved" } },
          "__rakazoCatalogTool",
        ),
      },
    ];
    const queue = createApprovedEffectReplayQueue(effects);
    const replay = approvedCatalogReplay(
      queue,
      "installed_execute_tool",
      "__rakazoCatalogTool",
      true,
    );
    const modelRuntimeArgs = {
      id: "install-B:delete_item",
      arguments: { target: "model-reconstructed" },
    };
    const tools: ConnectorTool[] = ["install-A", "install-B"].map((resourceId) => ({
      name: "delete_item",
      description: "Delete one item",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
      route: { connectorId: "installed", resourceId, toolName: "delete_item" },
    }));

    const resolved = resolveCatalogCall(
      {
        tool: "installed_execute_tool",
        args: replay.args ?? modelRuntimeArgs,
        executionId: "approved",
        route: { connectorId: "installed", toolName: "__catalog_execute" },
      },
      catalogEntries(tools),
    );

    expect(resolved.call.route?.resourceId).toBe("install-A");
    expect(resolved.call.args).toEqual({ target: "approved" });
  });

  it("keeps resolveCall parsed args when draining an approved catalog replay", () => {
    const marker = "__rakazoCatalogTool";
    const approvedRequest = catalogApprovalRequest(
      "installed_execute_tool",
      { id: "install-A:create_item", arguments: {} },
      marker,
    );
    const queue = createApprovedEffectReplayQueue([
      { kind: "create_item", request: approvedRequest },
    ]);
    const replay = approvedCatalogReplay(queue, "installed_execute_tool", marker, true);
    const tool: ConnectorTool = {
      name: "create_item",
      description: "Create one item",
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer", default: 3 } },
        additionalProperties: false,
      },
      route: { connectorId: "installed", resourceId: "install-A", toolName: "create_item" },
    };
    const resolved = resolveCatalogCall(
      {
        tool: "installed_execute_tool",
        args: replay.args!,
        executionId: "approved",
        route: { connectorId: "installed", toolName: "__catalog_execute" },
      },
      catalogEntries([tool]),
    );
    const replayed = approvedReplayArgs(queue.take(tool.name)!, resolved.call.args, marker);

    expect(resolved.call.args).toEqual({ count: 3 });
    expect(replayed).toEqual({ count: 3 });
    expect(replayed).not.toEqual({});
    expect(approvalEffectKey("run", tool.name, replayed)).toBe(
      approvalEffectKey("run", tool.name, resolved.call.args),
    );
    expect(queue.assertDrained).not.toThrow();
  });

  it("preserves direct approved args that use the catalog marker as data", () => {
    const approvedRequest = {
      __rakazoCatalogTool: "user-provided-value",
      target: "approved",
    };

    expect(
      approvedReplayArgs(
        approvedRequest,
        { __rakazoCatalogTool: "user-provided-value", target: "reconstructed" },
        "__rakazoCatalogTool",
      ),
    ).toEqual(approvedRequest);
  });
});
