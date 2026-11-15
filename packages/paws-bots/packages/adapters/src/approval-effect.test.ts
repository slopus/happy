import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import {
  approvalPausedToolResult,
  approvalReplayPathError,
  approvalReplayResourceError,
  approvedCatalogReplay,
  approvedEffectOccurrence,
  approvedReplayArgs,
  boundDirectApprovalRequest,
  catalogApprovalConnectorId,
  catalogApprovalDetails,
  catalogApprovalMatchesLiveRoute,
  catalogApprovalRequest,
  catalogExecuteToolName,
  catalogIdForRoute,
  catalogToolPrefix,
  claimApprovedEffect,
  claimIntendedEffect,
  completeExternalEffect,
  createApprovedEffectReplayQueue,
  isApprovalPausedResult,
  isInternalTermination,
  isTerminatingReplyResult,
  isToolPauseResult,
  replaceCompletedExternalEffectResult,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
  terminatingToolResult,
  uncertainEffectResult,
} from "./approval-effect.js";

describe("approved effect replay", () => {
  it("binds direct and catalog approvals to the selected account", () => {
    const marker = "__rakazoCatalogTool";
    const route = {
      connectorId: "example",
      resourceId: "mail",
      toolName: "send",
      connectionId: "work",
    };
    const args = { text: "approved" };
    const direct = boundDirectApprovalRequest(route, args, marker);
    const catalog = catalogApprovalRequest(
      "example_execute_tool",
      { id: catalogIdForRoute(route), arguments: args },
      marker,
      route,
    );
    expect(catalogIdForRoute(route)).toBe("mail:work:send");
    for (const approved of [direct, catalog]) {
      expect(approvalReplayResourceError("send", false, approved, route, marker)).toBeUndefined();
      expect(
        approvalReplayResourceError(
          "send",
          false,
          approved,
          { ...route, connectionId: "home" },
          marker,
        ),
      ).toBeDefined();
      expect(
        approvalReplayResourceError(
          "send",
          false,
          approved,
          { ...route, connectionId: undefined },
          marker,
        ),
      ).toBeDefined();
    }
    const legacy = catalogApprovalRequest(
      "example_execute_tool",
      { id: "mail:send", arguments: args },
      marker,
    );
    expect(approvalReplayResourceError("send", false, legacy, route, marker)).toBeDefined();
  });

  it("replays persisted arguments instead of a changed model reconstruction", () => {
    const approved = { title: "Approved title", body: "Approved body" };
    const queue = createApprovedEffectReplayQueue([
      { kind: "destination.write", request: approved },
    ]);

    expect(queue.take("destination.write")).toEqual(approved);
    expect(queue.take("destination.write")).toBeUndefined();
  });

  it("keeps independently approved calls in creation order", () => {
    const queue = createApprovedEffectReplayQueue([
      { kind: "destination.write", request: { sequence: 1 } },
      { kind: "destination.write", request: { sequence: 2 } },
    ]);

    expect(queue.assertDrained).toThrow();
    expect(queue.take("destination.write")).toEqual({ sequence: 1 });
    expect(queue.assertDrained).toThrow();
    expect(queue.take("destination.write")).toEqual({ sequence: 2 });
    expect(queue.assertDrained).not.toThrow();
  });

  it("reads the occurrence an approved row's key encodes", () => {
    const base = approvalEffectKey("run", "destination.write", { sequence: 1 });
    expect(approvedEffectOccurrence(base, base)).toBe(0);
    expect(approvedEffectOccurrence(`${base}:2`, base)).toBe(2);
    expect(approvedEffectOccurrence(`${base}:0`, base)).toBeUndefined();
    expect(approvedEffectOccurrence(`${base}:x`, base)).toBeUndefined();
    expect(
      approvedEffectOccurrence(approvalEffectKey("run", "destination.write", {}), base),
    ).toBeUndefined();
  });

  it("does not consume a later tool before the next approved request", () => {
    const queue = createApprovedEffectReplayQueue([
      { kind: "first.write", request: { sequence: 1 } },
      { kind: "second.write", request: { sequence: 2 } },
    ]);

    expect(queue.nextToolName()).toBe("first.write");
    expect(queue.take("second.write")).toBeUndefined();
    expect(queue.nextToolName()).toBe("first.write");
    expect(queue.take("first.write")).toEqual({ sequence: 1 });
    expect(queue.nextToolName()).toBe("second.write");
  });

  it("does not treat a direct-tool arg named like the catalog marker as a catalog replay", () => {
    const marker = "__rakazoCatalogTool";
    const approved = {
      id: "row-1",
      arguments: { mode: "strict" },
      text: "approved exactly",
      [marker]: "looks-like-a-wrapper-but-is-an-arg",
    };
    const reconstructed = {
      id: "row-1",
      arguments: { mode: "model-changed" },
      text: "model reconstructed",
      [marker]: "looks-like-a-wrapper-but-is-an-arg",
    };
    expect(catalogApprovalDetails(approved, marker)).toBeUndefined();

    const queue = createApprovedEffectReplayQueue([{ kind: "notes.write", request: approved }]);
    expect(approvedCatalogReplay(queue, "notes.write", marker)).toEqual({});
    expect(approvedReplayArgs(queue.take("notes.write")!, reconstructed, marker)).toEqual(approved);
    expect(queue.assertDrained).not.toThrow();
  });

  it("still recognizes the full catalog envelope as a catalog replay", () => {
    const marker = "__rakazoCatalogTool";
    const approved = catalogApprovalRequest(
      "installed_execute_tool",
      { id: "install-A:notes.write", arguments: { text: "approved" } },
      marker,
    );
    expect(catalogApprovalDetails(approved, marker)).toEqual({
      toolName: "installed_execute_tool",
      args: { id: "install-A:notes.write", arguments: { text: "approved" } },
    });
    expect(approvedReplayArgs(approved, { text: "approved", mode: "fast" }, marker)).toEqual({
      text: "approved",
      mode: "fast",
    });
  });

  it("does not inject catalog envelope args onto a non-wrapper tool call", () => {
    const marker = "__rakazoCatalogTool";
    const catalog = catalogApprovalRequest(
      "installed_execute_tool",
      { id: "install-A:installed_execute_tool", arguments: { text: "approved" } },
      marker,
    );
    const queue = createApprovedEffectReplayQueue([
      { kind: "installed_execute_tool", request: catalog },
    ]);

    // Direct invocation must not receive the wrapper {id,arguments} envelope.
    expect(approvedCatalogReplay(queue, "installed_execute_tool", marker, false)).toEqual({});
    expect(approvedCatalogReplay(queue, "installed_execute_tool", marker, true)).toEqual({
      args: { id: "install-A:installed_execute_tool", arguments: { text: "approved" } },
    });
  });

  it("rejects cross-path replay when a catalog approval is invoked as a direct tool", () => {
    const marker = "__rakazoCatalogTool";
    const direct = boundDirectApprovalRequest(
      { connectorId: "installed", resourceId: "install-A", toolName: "notes.write" },
      { text: "approved exactly" },
      marker,
    );
    const catalog = catalogApprovalRequest(
      "installed_execute_tool",
      { id: "install-A:notes.write", arguments: { text: "catalog" } },
      marker,
    );
    const matching = {
      connectorId: "installed",
      resourceId: "install-A",
      toolName: "notes.write",
    };
    const other = {
      connectorId: "installed",
      resourceId: "install-B",
      toolName: "notes.write",
    };

    expect(approvalReplayPathError("notes.write", false, catalog, marker)).toMatch(
      /must be replayed via its catalog execute tool/,
    );
    expect(approvalReplayPathError("notes.write", false, catalog, marker, other)).toMatch(
      /must be replayed via its catalog execute tool/,
    );
    expect(
      approvalReplayPathError("notes.write", false, catalog, marker, matching),
    ).toBeUndefined();
    expect(
      approvalReplayPathError("notes.write", false, catalog, marker, {
        ...matching,
        resourceRevision: 2,
      }),
    ).toMatch(/must be replayed via its catalog execute tool/);
    const boundCatalog = catalogApprovalRequest(
      "installed_execute_tool",
      { id: "install-A:notes.write", arguments: { text: "catalog" } },
      marker,
      {
        connectorId: "installed",
        resourceId: "install-A",
        resourceRevision: 1,
        toolName: "notes.write",
      },
    );
    expect(
      approvalReplayPathError("notes.write", false, boundCatalog, marker, {
        ...matching,
        resourceRevision: 1,
      }),
    ).toBeUndefined();
    expect(
      approvalReplayPathError("notes.write", false, boundCatalog, marker, {
        ...matching,
        resourceRevision: 2,
      }),
    ).toMatch(/must be replayed via its catalog execute tool/);
    expect(approvalReplayPathError("notes.write", true, direct, marker)).toBeUndefined();
    expect(approvalReplayPathError("notes.write", false, direct, marker)).toBeUndefined();
    expect(approvalReplayPathError("notes.write", true, catalog, marker)).toBeUndefined();
  });

  it("replays a bound direct approval through catalog only on the same resource", () => {
    const marker = "__rakazoCatalogTool";
    const approved = boundDirectApprovalRequest(
      {
        connectorId: "installed",
        resourceId: "install-A",
        resourceRevision: 1,
        toolName: "notes.write",
      },
      { text: "approved exactly", mode: "fast" },
      marker,
    );
    const same = {
      connectorId: "installed",
      resourceId: "install-A",
      resourceRevision: 1,
      toolName: "notes.write",
    };
    const other = {
      connectorId: "installed",
      resourceId: "install-B",
      resourceRevision: 1,
      toolName: "notes.write",
    };
    // Quiet token refresh keeps revision; OAuth reauth increments it.
    const quietRefresh = {
      connectorId: "installed",
      resourceId: "install-A",
      resourceRevision: 1,
      toolName: "notes.write",
    };
    const reauthorized = {
      connectorId: "installed",
      resourceId: "install-A",
      resourceRevision: 2,
      toolName: "notes.write",
    };

    expect(
      approvalReplayResourceError("notes.write", true, approved, same, marker),
    ).toBeUndefined();
    expect(
      approvalReplayResourceError("notes.write", false, approved, same, marker),
    ).toBeUndefined();
    expect(approvalReplayResourceError("notes.write", true, approved, other, marker)).toMatch(
      /different connector resource/,
    );
    expect(approvalReplayResourceError("notes.write", false, approved, other, marker)).toMatch(
      /different connector resource/,
    );
    expect(
      approvalReplayResourceError("notes.write", false, approved, quietRefresh, marker),
    ).toBeUndefined();
    expect(
      approvalReplayResourceError("notes.write", false, approved, reauthorized, marker),
    ).toMatch(/different connector resource/);
    expect(
      approvalReplayResourceError("notes.write", true, { text: "legacy" }, same, marker),
    ).toMatch(/must be replayed as a direct tool call/);
    expect(
      approvalReplayResourceError("notes.write", false, { text: "legacy" }, same, marker),
    ).toBeUndefined();
    expect(approvedReplayArgs(approved, { text: "model" }, marker)).toEqual({
      text: "approved exactly",
      mode: "fast",
    });
  });
});

describe("approvalEffectKey", () => {
  it("is stable across arg key order", () => {
    const left = approvalEffectKey("run-1", "destination.write", {
      collection: "notes",
      title: "Result",
      body: "hello",
    });
    const right = approvalEffectKey("run-1", "destination.write", {
      body: "hello",
      collection: "notes",
      title: "Result",
    });
    expect(left).toBe(right);
  });

  it("differs when args change", () => {
    const first = approvalEffectKey("run-1", "destination.write", { body: "one" });
    const second = approvalEffectKey("run-1", "destination.write", { body: "two" });
    expect(first).not.toBe(second);
  });
});

describe("resolveDuplicateEffectGate", () => {
  it("executes only after approval", () => {
    expect(resolveDuplicateEffectGate({ status: "approved" }, "archive_bot")).toEqual({
      action: "execute",
    });
  });

  it("returns denial without executing", () => {
    expect(resolveDuplicateEffectGate({ status: "denied" }, "destination.write")).toEqual({
      action: "return",
      result: {
        error:
          "The user denied this action. Do not retry or rephrase it; tell the user and ask what they want instead.",
      },
    });
  });

  it("returns paused for intended effects instead of executing", () => {
    expect(resolveDuplicateEffectGate({ status: "intended" }, "archive_bot")).toEqual({
      action: "paused",
    });
    expect(resolveDuplicateEffectGate({ status: "intended" }, "delete_bot")).toEqual({
      action: "paused",
    });
  });

  it("fails closed for executing effects", () => {
    expect(resolveDuplicateEffectGate({ status: "executing" }, "destination.write")).toEqual({
      action: "uncertain",
      toolName: "destination.write",
    });
  });

  it("returns a previously reconciled uncertain result", () => {
    const result = { error: "outcome unknown", uncertain: true };
    expect(
      resolveDuplicateEffectGate({ status: "uncertain", result }, "destination.write"),
    ).toEqual({ action: "return", result });
  });
});

describe("uncertainEffectResult", () => {
  const listFleetHint = "Call list_fleet to check whether it happened before retrying.";
  it.each([
    ["update_bot", { bot_id: "bot-child", name: "Ranger" }],
    ["set_child_instructions", {}],
  ])("points %s to list_fleet before a retry", (toolName, args) => {
    expect(uncertainEffectResult(toolName, args).error).toContain(listFleetHint);
  });

  it.each(["set_child_bot_model", "create_child_routine"])(
    "asks the owner to verify uncertain %s outcomes",
    (tool) => {
      expect(uncertainEffectResult(tool).error).toContain("Ask the owner to verify the outcome");
      expect(uncertainEffectResult(tool).error).toContain("do not retry automatically");
    },
  );

  it("keeps the destination hint for update_bot on the bot itself", () => {
    expect(uncertainEffectResult("update_bot", { name: "Me" }).error).not.toContain("list_fleet");
  });
});

describe("claimApprovedEffect", () => {
  it("claims approved effects exactly once", async () => {
    const store = {
      externalEffect: {
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      },
    };

    await expect(claimApprovedEffect(store, "effect-1")).resolves.toBe(true);
    await expect(claimApprovedEffect(store, "effect-1")).resolves.toBe(false);
    expect(store.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "approved" },
      data: { status: "executing" },
    });
  });
});

describe("claimIntendedEffect", () => {
  it("claims intended effects exactly once", async () => {
    const store = {
      externalEffect: {
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      },
    };

    await expect(claimIntendedEffect(store, "effect-1")).resolves.toBe(true);
    await expect(claimIntendedEffect(store, "effect-1")).resolves.toBe(false);
    expect(store.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "intended" },
      data: { status: "executing" },
    });
  });
});

describe("replaceCompletedExternalEffectResult", () => {
  it("updates the stored result for a completed effect", async () => {
    const store = {
      externalEffect: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const result = { ok: true, submitted: true, connected: true };

    await expect(replaceCompletedExternalEffectResult(store, "effect-1", result)).resolves.toBe(
      true,
    );
    expect(store.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "completed" },
      data: { result },
    });
  });
});

describe("completeExternalEffect", () => {
  it("does not let a stale worker overwrite a reconciled effect", async () => {
    const store = {
      externalEffect: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const result = { written: true };

    await expect(completeExternalEffect(store, "effect-1", "executing", result)).resolves.toBe(
      false,
    );
    expect(store.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "executing" },
      data: { status: "completed", result },
    });
  });
});

describe("approved effect resume", () => {
  function createApprovedEffectStore(
    initialStatus: "approved" | "executing" | "completed" = "approved",
  ) {
    const effectId = "effect-1";
    let status: "approved" | "executing" | "completed" | "uncertain" = initialStatus;
    let destinationWrites = 0;
    const storedResult = { ok: true, written: true };
    let effectResult: unknown;
    const store = {
      externalEffect: {
        updateMany: vi.fn(async ({ where, data }) => {
          if (where.id === effectId && where.status === "approved" && status === "approved") {
            status = data.status as typeof status;
            return { count: 1 };
          }
          if (where.id === effectId && where.status === "executing" && status === "executing") {
            status = data.status as typeof status;
            effectResult = data.result;
            return { count: 1 };
          }
          return { count: 0 };
        }),
        findUnique: vi.fn(async (_args: { where: { id: string } }) => ({
          id: effectId,
          status,
          result: status === "completed" ? storedResult : effectResult,
        })),
      },
    };

    const resumeApprovedTool = async (toolName: string, options?: { complete?: boolean }) => {
      const current = await store.externalEffect.findUnique({ where: { id: effectId } });
      const effect = current ?? { id: effectId, status, result: undefined as unknown };
      const gate = resolveDuplicateEffectGate(effect, toolName);
      if (gate.action === "return") return { executed: false, result: gate.result };
      if (gate.action === "uncertain") {
        return {
          executed: false,
          result: await settleUncertainEffect(store, effectId, toolName),
        };
      }
      if (!(await claimApprovedEffect(store, effectId))) {
        const current = await store.externalEffect.findUnique({ where: { id: effectId } });
        if (!current) {
          throw new Error(`tool ${toolName} has an earlier execution with an uncertain outcome`);
        }
        const retryGate = resolveDuplicateEffectGate(current, toolName);
        if (retryGate.action === "return") return { executed: false, result: retryGate.result };
        if (retryGate.action === "uncertain") {
          return {
            executed: false,
            result: await settleUncertainEffect(store, effectId, toolName),
          };
        }
        throw new Error(`tool ${toolName} has an earlier execution with an uncertain outcome`);
      }
      destinationWrites += 1;
      if (options?.complete !== false) {
        status = "completed";
      }
      return { executed: true, result: storedResult };
    };

    return {
      store,
      resumeApprovedTool,
      getDestinationWrites: () => destinationWrites,
      getStatus: () => status,
    };
  }

  it("records an unknown outcome without replaying after interruption", async () => {
    const harness = createApprovedEffectStore();

    const first = await harness.resumeApprovedTool("destination.write", { complete: false });
    const second = await harness.resumeApprovedTool("destination.write");

    expect(first).toEqual({ executed: true, result: { ok: true, written: true } });
    expect(second).toEqual({
      executed: false,
      result: expect.objectContaining({ uncertain: true }),
    });
    expect(harness.getStatus()).toBe("uncertain");
    expect(harness.getDestinationWrites()).toBe(1);
  });

  it("returns the stored result after the approved effect completed", async () => {
    const harness = createApprovedEffectStore();

    await harness.resumeApprovedTool("destination.write");
    const second = await harness.resumeApprovedTool("destination.write");

    expect(second).toEqual({ executed: false, result: { ok: true, written: true } });
    expect(harness.getDestinationWrites()).toBe(1);
  });
});

describe("isToolPauseResult", () => {
  it("detects approval and secret pauses", () => {
    expect(isToolPauseResult(approvalPausedToolResult())).toBe(true);
    expect(
      isToolPauseResult({
        kind: "agent_tool_result",
        terminate: true,
        details: { secret: "paused" },
      }),
    ).toBe(true);
    expect(isToolPauseResult({ ok: true })).toBe(false);
  });
});

describe("approvalPausedToolResult", () => {
  it("returns a terminating agent tool result", () => {
    const paused = approvalPausedToolResult();
    expect(isApprovalPausedResult(paused)).toBe(true);
    expect(paused).toMatchObject({
      kind: "agent_tool_result",
      terminate: true,
      details: { approval: "paused" },
    });
    expect(isApprovalPausedResult({ ok: true })).toBe(false);
  });
});

describe("catalog wrapper names", () => {
  it("maps MCP to connectors and leaves other connector ids unchanged", () => {
    expect(catalogToolPrefix("mcp")).toBe("connectors");
    expect(catalogToolPrefix("installed")).toBe("installed");
    expect(catalogExecuteToolName("mcp")).toBe("connectors_execute_tool");
    expect(catalogExecuteToolName("installed")).toBe("installed_execute_tool");
    expect(catalogApprovalConnectorId("connectors_execute_tool")).toBe("mcp");
    expect(catalogApprovalConnectorId("mcp_execute_tool")).toBe("mcp");
    expect(catalogApprovalConnectorId("installed_execute_tool")).toBe("installed");
  });

  it("matches a connectors_execute_tool approval to a live MCP route", () => {
    expect(
      catalogApprovalMatchesLiveRoute(
        {
          toolName: "connectors_execute_tool",
          args: { id: "server-1:send_message", arguments: { text: "approved" } },
        },
        { connectorId: "mcp", resourceId: "server-1", toolName: "send_message" },
      ),
    ).toBe(true);
  });
});

it("keeps termination provenance through internal copies but not connector JSON", () => {
  const result = terminatingToolResult("Internal refusal", { refused: "owner-settings" });
  expect(isTerminatingReplyResult(result)).toBe(true);
  expect(isTerminatingReplyResult({ ...result })).toBe(true);
  expect(isTerminatingReplyResult(JSON.parse(JSON.stringify(result)))).toBe(false);
  const pause = approvalPausedToolResult();
  expect(isInternalTermination({ ...pause })).toBe(true);
  expect(isInternalTermination(JSON.parse(JSON.stringify(pause)))).toBe(false);
  expect(isTerminatingReplyResult(pause)).toBe(false);
});
