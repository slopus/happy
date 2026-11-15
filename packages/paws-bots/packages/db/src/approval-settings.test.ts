import { describe, expect, it, vi } from "vitest";
import {
  findAutoReviewPreference,
  listApprovalRules,
  removeApprovalRule,
  saveApprovalRule,
  saveAutoReviewPreference,
} from "./approval-settings.js";
import type { PrismaClient } from "./client.js";

const scope = { userId: "user", spaceId: "space" };
const rule = { effect: "always_allow", matchKind: "tool", matchValue: "send" };

function confirmationsClient({ overridden = false } = {}) {
  const table = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ id: "row" }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  });
  const tables = {
    actionApprovalRule: table(),
    userActionApprovalRule: table(),
    actionAutoReviewPreference: table(),
    userActionAutoReviewPreference: table(),
  };
  const spaceSettingOverride = {
    findUnique: vi.fn().mockResolvedValue(overridden ? { setting: "confirmations" } : null),
  };
  const prisma = {
    ...tables,
    spaceSettingOverride,
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
  } as unknown as PrismaClient;
  return { prisma, ...tables, spaceSettingOverride };
}

describe("approval rules", () => {
  it("follow the account when the Space has no override", async () => {
    const client = confirmationsClient();

    await listApprovalRules(client.prisma, scope);
    await saveApprovalRule(client.prisma, scope, rule);
    await removeApprovalRule(client.prisma, scope, "rule-1");

    expect(client.userActionApprovalRule.findMany).toHaveBeenCalledWith({
      where: { userId: "user" },
      orderBy: { createdAt: "asc" },
    });
    expect(client.userActionApprovalRule.upsert).toHaveBeenCalledWith({
      where: { userId_effect_matchKind_matchValue: { userId: "user", ...rule } },
      create: { userId: "user", ...rule },
      update: {},
    });
    expect(client.userActionApprovalRule.deleteMany).toHaveBeenCalledWith({
      where: { id: "rule-1", userId: "user" },
    });
    expect(client.actionApprovalRule.findMany).not.toHaveBeenCalled();
    expect(client.actionApprovalRule.upsert).not.toHaveBeenCalled();
    expect(client.actionApprovalRule.deleteMany).not.toHaveBeenCalled();
  });

  it("replace every other rule for the same match, including case variants", async () => {
    const client = confirmationsClient();
    client.userActionApprovalRule.findMany.mockResolvedValueOnce([
      { id: "same", effect: "always_allow", matchValue: "send" },
      { id: "upper", effect: "always_allow", matchValue: "SEND" },
      { id: "ask", effect: "require_approval", matchValue: "Send" },
      { id: "other", effect: "always_allow", matchValue: "send_email" },
    ]);

    await saveApprovalRule(client.prisma, scope, rule);

    expect(client.userActionApprovalRule.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["upper", "ask"] } },
    });
  });

  it("use the Space's own copy when it overrides confirmations", async () => {
    const client = confirmationsClient({ overridden: true });

    await listApprovalRules(client.prisma, scope);
    await saveApprovalRule(client.prisma, scope, rule);
    await removeApprovalRule(client.prisma, scope, "rule-1");

    const owner = { spaceId: "space", createdByUserId: "user" };
    expect(client.actionApprovalRule.findMany).toHaveBeenCalledWith({
      where: owner,
      orderBy: { createdAt: "asc" },
    });
    expect(client.actionApprovalRule.upsert).toHaveBeenCalledWith({
      where: { spaceId_createdByUserId_effect_matchKind_matchValue: { ...owner, ...rule } },
      create: { ...owner, ...rule },
      update: {},
    });
    expect(client.actionApprovalRule.deleteMany).toHaveBeenCalledWith({
      where: { id: "rule-1", ...owner },
    });
    expect(client.userActionApprovalRule.findMany).not.toHaveBeenCalled();
  });

  it("act on the named copy whatever applies in the Space", async () => {
    const client = confirmationsClient({ overridden: true });

    await listApprovalRules(client.prisma, scope, "account");

    expect(client.spaceSettingOverride.findUnique).not.toHaveBeenCalled();
    expect(client.userActionApprovalRule.findMany).toHaveBeenCalled();
    expect(client.actionApprovalRule.findMany).not.toHaveBeenCalled();
  });
});

describe("auto review", () => {
  it("reads and writes the account's choice when the Space follows it", async () => {
    const client = confirmationsClient();
    client.userActionAutoReviewPreference.findUnique.mockResolvedValue({
      enabled: true,
      skipApprovals: false,
    });

    await expect(findAutoReviewPreference(client.prisma, scope)).resolves.toEqual({
      enabled: true,
      skipApprovals: false,
    });
    await saveAutoReviewPreference(
      client.prisma,
      scope,
      { skipApprovals: true },
      { enabled: false, skipApprovals: false },
    );

    expect(client.userActionAutoReviewPreference.upsert).toHaveBeenCalledWith({
      where: { userId: "user" },
      create: { userId: "user", enabled: false, skipApprovals: true },
      update: { skipApprovals: true },
    });
    expect(client.actionAutoReviewPreference.findUnique).not.toHaveBeenCalled();
    expect(client.actionAutoReviewPreference.upsert).not.toHaveBeenCalled();
  });

  it("writes the Space's own choice when asked for the Space", async () => {
    const client = confirmationsClient();

    await saveAutoReviewPreference(
      client.prisma,
      scope,
      { enabled: true },
      { enabled: false, skipApprovals: false },
      "space",
    );

    expect(client.actionAutoReviewPreference.upsert).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: "space", userId: "user" } },
      create: { spaceId: "space", userId: "user", enabled: true, skipApprovals: false },
      update: { enabled: true },
    });
    expect(client.userActionAutoReviewPreference.upsert).not.toHaveBeenCalled();
  });
});
