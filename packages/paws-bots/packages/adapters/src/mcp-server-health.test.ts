import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCP_DYNAMIC_REGISTRATION_UNSUPPORTED,
  mcpServerHealthDto,
  recordMcpServerHealth,
} from "./mcp-server-health.js";

function fakePrisma(updateMany = vi.fn().mockResolvedValue({ count: 1 })) {
  return { prisma: { mcpServer: { updateMany } } as unknown as PrismaClient, updateMany };
}

afterEach(() => {
  installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
});

describe("recordMcpServerHealth", () => {
  it("writes only the health columns for the server id, stamping the check time", async () => {
    const { prisma, updateMany } = fakePrisma();
    const before = Date.now();

    await recordMcpServerHealth(prisma, "server-1", {
      status: "error",
      message: "spawn npx ENOENT",
      toolCount: null,
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: "server-1" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "healthCheckedAt",
      "healthMessage",
      "healthStatus",
      "healthToolCount",
    ]);
    expect(arg.data).toMatchObject({
      healthStatus: "error",
      healthMessage: "spawn npx ENOENT",
      healthToolCount: null,
    });
    expect(arg.data.healthCheckedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("clears the message on ok and records the tool count", async () => {
    const { prisma, updateMany } = fakePrisma();

    await recordMcpServerHealth(prisma, "server-1", {
      status: "ok",
      message: "stale note",
      toolCount: 7,
    });

    expect(updateMany.mock.calls[0]![0].data).toMatchObject({
      healthStatus: "ok",
      healthMessage: null,
      healthToolCount: 7,
    });
  });

  it("truncates long messages and nulls an empty or absent one", async () => {
    const { prisma, updateMany } = fakePrisma();

    await recordMcpServerHealth(prisma, "s", { status: "error", message: "x".repeat(5000) });
    await recordMcpServerHealth(prisma, "s", { status: "error", message: "" });
    await recordMcpServerHealth(prisma, "s", { status: "installing" });

    expect(updateMany.mock.calls[0]![0].data.healthMessage).toHaveLength(2000);
    expect(updateMany.mock.calls[1]![0].data.healthMessage).toBeNull();
    expect(updateMany.mock.calls[2]![0].data).toMatchObject({
      healthMessage: null,
      healthToolCount: null,
    });
  });

  it("records only against the revision it is about, when given one", async () => {
    const { prisma, updateMany } = fakePrisma();
    await recordMcpServerHealth(prisma, "s", { status: "error", message: "x" }, 3);
    expect(updateMany.mock.calls[0]![0].where).toEqual({ id: "s", revision: 3 });
  });

  it("never touches the revision", async () => {
    const { prisma, updateMany } = fakePrisma();
    await recordMcpServerHealth(prisma, "s", { status: "ok", toolCount: 1 });
    expect(updateMany.mock.calls[0]![0].data).not.toHaveProperty("revision");
  });

  it("swallows and logs a failed write", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo", level: "info", sinks: [sink] }));
    const { prisma } = fakePrisma(vi.fn().mockRejectedValue(new Error("db down")));

    await expect(
      recordMcpServerHealth(prisma, "server-1", { status: "ok" }),
    ).resolves.toBeUndefined();

    expect(sink.events.some((event) => event.message === "mcp server health write failed")).toBe(
      true,
    );
  });
});

describe("mcpServerHealthDto", () => {
  it("maps columns and falls back to unknown for an unrecognised status", () => {
    const checkedAt = new Date("2026-10-21T10:00:00.000Z");
    expect(
      mcpServerHealthDto({
        healthStatus: "ok",
        healthMessage: null,
        healthToolCount: 3,
        healthCheckedAt: checkedAt,
      }),
    ).toEqual({
      status: "ok",
      message: null,
      code: null,
      toolCount: 3,
      checkedAt: checkedAt.toISOString(),
    });
    expect(
      mcpServerHealthDto({
        healthStatus: "bogus",
        healthMessage: null,
        healthToolCount: null,
        healthCheckedAt: null,
      }),
    ).toEqual({ status: "unknown", message: null, code: null, toolCount: null, checkedAt: null });
  });

  it("marks a server that needs a pre-registered OAuth client", () => {
    const row = {
      healthStatus: "error",
      healthMessage: MCP_DYNAMIC_REGISTRATION_UNSUPPORTED,
      healthToolCount: null,
      healthCheckedAt: null,
    };
    expect(mcpServerHealthDto(row).code).toBe(MCP_OAUTH_CLIENT_REQUIRED);
    expect(mcpServerHealthDto({ ...row, healthMessage: "fetch failed" }).code).toBeNull();
  });
});
