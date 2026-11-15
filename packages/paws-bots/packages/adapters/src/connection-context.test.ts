import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { mergeConnectedPlugins } from "./composio-connector.js";
import { persistLivePluginConnections, selectRunConnections } from "./connection-context.js";

describe("run connection selection", () => {
  it("uses synchronized account statuses in the current run", async () => {
    const rows = [
      { id: "gmail", provider: "gmail", status: "error" },
      { id: "slack", provider: "slack", status: "revoked" },
      { id: "slack-old", provider: "slack", status: "revoked" },
      { id: "gmail-duplicate", provider: "gmail", status: "pending" },
    ].map((row) => ({ ...row, connectorId: "composio", displayName: row.provider }));
    const prisma = {
      connection: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    } as unknown as PrismaClient;
    const liveSlugs = ["gmail", "slack"];

    await persistLivePluginConnections(
      prisma,
      { userId: "user", spaceId: "space" },
      rows,
      liveSlugs,
    );

    expect(rows.map((row) => row.status)).toEqual(["connected", "revoked", "revoked", "revoked"]);
    expect(
      selectRunConnections(
        rows,
        mergeConnectedPlugins(rows, liveSlugs).map((row) => row.provider),
      ),
    ).toEqual([rows[0]]);
  });

  it("does not recover a revoked account from a live provider listing", async () => {
    const rows = [
      {
        id: "slack",
        connectorId: "composio",
        provider: "slack",
        displayName: "Slack",
        status: "revoked",
      },
    ];
    const prisma = {
      connection: { updateMany: vi.fn().mockRejectedValue(new Error("database unavailable")) },
    } as unknown as PrismaClient;
    await persistLivePluginConnections(prisma, { userId: "user", spaceId: "space" }, rows, [
      "slack",
    ]);
    expect(prisma.connection.updateMany).not.toHaveBeenCalled();
    expect(rows[0]?.status).toBe("revoked");
    expect(selectRunConnections(rows, ["slack"])).toEqual([]);
  });

  it("does not send revoked accounts alongside a reconnected toolkit", () => {
    const oldAccount = {
      id: "youtube-old",
      connectorId: "composio",
      provider: "youtube",
      displayName: "YouTube",
      status: "revoked",
      providerRef: "ca_old",
    };
    const currentAccount = {
      ...oldAccount,
      id: "youtube-live",
      status: "connected",
      providerRef: "ca_current",
    };
    expect(selectRunConnections([oldAccount, currentAccount], ["youtube"])).toEqual([
      currentAccount,
    ]);
    expect(
      selectRunConnections(
        [oldAccount, currentAccount],
        mergeConnectedPlugins([oldAccount, currentAccount], ["youtube"]).map((row) => row.provider),
      ),
    ).toEqual([currentAccount]);
  });

  it("does not revive a revoked sibling with a dead providerRef during live persist", async () => {
    const oldAccount = {
      id: "gmail-old",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "revoked",
      providerRef: "ca_old",
    };
    const currentAccount = {
      ...oldAccount,
      id: "gmail-live",
      status: "connected",
      providerRef: "ca_current",
    };
    const rows = [oldAccount, currentAccount];
    const prisma = {
      connection: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;

    await persistLivePluginConnections(prisma, { userId: "user", spaceId: "space" }, rows, [
      "gmail",
    ]);

    expect(prisma.connection.updateMany).not.toHaveBeenCalled();
    expect(oldAccount.status).toBe("revoked");
    expect(selectRunConnections(rows, ["gmail"]).map((row) => row.providerRef)).toEqual([
      "ca_current",
    ]);
  });

  it("preserves live connection recovery and connected accounts from other providers", () => {
    const pending = { connectorId: "composio", provider: "youtube", status: "pending" };
    const revoked = { ...pending, status: "revoked" };
    const other = { connectorId: "pipedream", provider: "youtube", status: "connected" };
    const disconnected = { ...other, status: "error" };
    expect(selectRunConnections([pending, revoked, other, disconnected], ["youtube"])).toEqual([
      pending,
      other,
    ]);
    expect(
      selectRunConnections(
        [revoked, { ...pending, status: "connected" }, other, disconnected],
        ["youtube"],
      ),
    ).toEqual([{ ...pending, status: "connected" }, other]);
  });
});
