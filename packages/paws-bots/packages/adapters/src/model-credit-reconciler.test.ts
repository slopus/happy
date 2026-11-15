import type { AgentUsage, ModelUsageLookup } from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { recordUsage } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCreditReconciler } from "./model-credit-reconciler.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordUsage: vi.fn(),
}));

function harness(call: Record<string, unknown>, run: Record<string, unknown> | null = null) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    run: { findUnique: vi.fn().mockResolvedValue(run) },
    modelCreditLot: { findMany: vi.fn().mockResolvedValue([]) },
    modelCreditEntry: { findMany: vi.fn().mockResolvedValue([call]), updateMany },
    modelCreditAccount: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
  return { prisma, updateMany };
}

const baseCall = {
  id: "entry-1",
  callId: "call-1",
  userId: "user-1",
  spaceId: "space-1",
  runId: "run-1",
  provider: "fake",
  model: "fake-model",
  pending: true,
  usage: null,
  providerRequestId: null,
  auditRevision: 0,
  // A $1 hold.
  amountMicros: -1_000_000n,
  reconciliationAttempts: 0,
};

// Dollars per million tokens.
const pricingSnapshot = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const stopped: AgentUsage = {
  providerRequestId: "gen-fixture",
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  costSource: null,
  usageSource: "pi-normalized",
  pricingSnapshot,
  countedTokens: { inputTokens: 100_000, outputTokens: 2_000 },
};
const lookup = (lookupUsage: ModelUsageLookup["lookupUsage"]): ModelUsageLookup => ({
  provider: "fake",
  lookupUsage,
});
const reconcile = (
  call: Record<string, unknown>,
  usageLookup?: ModelUsageLookup,
  run?: Record<string, unknown> | null,
) => {
  const { prisma, updateMany } = harness({ ...baseCall, ...call }, run);
  return createModelCreditReconciler({
    prisma,
    lookup: usageLookup,
    now: () => new Date(0),
  })().then(() => updateMany);
};
const charged = () => vi.mocked(recordUsage).mock.calls[0]?.[1];

describe("model credit reconciler", () => {
  beforeEach(() => vi.mocked(recordUsage).mockReset());
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
  });

  it("charges the provider's cost for a stopped call when its lookup finds one", async () => {
    await reconcile(
      { usage: stopped, providerRequestId: "gen-fixture" },
      lookup(async () => ({
        inputTokens: 90_000,
        outputTokens: 2_500,
        costUsd: 0.21,
        costSource: "provider-reported",
      })),
    );
    expect(charged()).toMatchObject({ costUsd: 0.21, costSource: "provider-reported" });
  });

  it("waits for the provider while lookups remain", async () => {
    const updateMany = await reconcile(
      { usage: stopped, providerRequestId: "gen-fixture", reconciliationAttempts: 4 },
      lookup(async () => null),
    );
    expect(recordUsage).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reconciliationState: "pending" }),
      }),
    );
  });

  it.each([
    ["finds no record", async () => null],
    [
      "fails",
      async () => {
        throw new Error("lookup failed (400)");
      },
    ],
  ])("prices counted tokens on the last attempt when the lookup %s", async (_case, find) => {
    const updateMany = await reconcile(
      { usage: stopped, providerRequestId: "gen-fixture", reconciliationAttempts: 5 },
      lookup(find),
    );
    // 100k prompt tokens at the cache-read rate plus 2k output tokens.
    expect(charged()).toMatchObject({ costUsd: 0.04, costSource: "reconciled-estimate" });
    expect(vi.mocked(recordUsage).mock.calls[0]?.[3]).toBe(true);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "entry-1", reconciliationState: "pending" },
      data: { reconciliationState: "complete", nextReconcileAt: null },
    });
  });

  it("prices counted tokens at once when the provider offers no lookup", async () => {
    await reconcile({ usage: stopped, providerRequestId: "gen-fixture" });
    expect(charged()).toMatchObject({ costUsd: 0.04, costSource: "reconciled-estimate" });
  });

  it("prices partial provider-reported tokens at their own rates", async () => {
    await reconcile({
      usage: {
        ...stopped,
        countedTokens: undefined,
        inputTokens: 10_000,
        cacheReadTokens: 50_000,
        outputTokens: null,
      },
    });
    expect(charged()?.costUsd).toBeCloseTo(0.03);
  });

  it("fills output the provider never reported from our own count", async () => {
    await reconcile({ usage: { ...stopped, inputTokens: 10_000 } });
    // 10k reported input at the full rate plus 2k counted output.
    expect(charged()?.costUsd).toBeCloseTo(0.04);
  });

  it("charges reported cache buckets without counting them twice", async () => {
    await reconcile({ usage: { ...stopped, cacheReadTokens: 50_000, cacheWriteTokens: 10_000 } });
    // 50k read at 0.2, 10k written at 2.5, the other 40k prompt at 0.2, and 2k output at 10.
    expect(charged()?.costUsd).toBeCloseTo(0.063);
  });

  it("ignores an invalid stored cost and prices the tokens instead", async () => {
    await reconcile({ usage: { ...stopped, costUsd: -1 } });
    expect(charged()?.costUsd).toBeCloseTo(0.04);
  });

  it("holds counted tokens it has no price for", async () => {
    const updateMany = await reconcile({
      usage: { ...stopped, pricingSnapshot: null },
      reconciliationAttempts: 5,
    });
    expect(recordUsage).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reconciliationState: "needs_review" }),
      }),
    );
  });

  it.each([
    ["the user stopped its run", { status: "cancelled", error: null }, 0.22],
    ["the run was deleted", null, 0.22],
    ["a deploy or stalled stream aborted it", { status: "queued", error: null }, 0.04],
    [
      "the system cancelled a stuck run",
      { status: "cancelled", error: "Run stopped responding" },
      0.04,
    ],
  ])("prices an aborted call safely when %s", async (_case, run, costUsd) => {
    await reconcile(
      {
        usage: {
          ...stopped,
          countedTokens: { ...stopped.countedTokens!, ifStopped: stopped.countedTokens! },
        },
      },
      undefined,
      run,
    );
    // Full: 100k prompt at the input rate. Low: at the cache-read rate. Both add 2k output.
    expect(charged()?.costUsd).toBeCloseTo(costUsd);
  });

  it("charges the output it received over a placeholder output count", async () => {
    await reconcile(
      {
        usage: {
          ...stopped,
          inputTokens: 10_000,
          outputTokens: 1,
          countedTokens: {
            inputTokens: 10_000,
            outputTokens: 200,
            ifStopped: { inputTokens: 10_000, outputTokens: 5_000 },
          },
        },
      },
      undefined,
      { status: "cancelled", error: null },
    );
    // 10k reported input at the full rate plus the 5k output tokens the user received.
    expect(charged()?.costUsd).toBeCloseTo(0.07);
  });

  it("caps a stopped call's full-rate charge at the hold", async () => {
    await reconcile(
      {
        usage: {
          ...stopped,
          countedTokens: {
            ...stopped.countedTokens!,
            ifStopped: { inputTokens: 1_000_000, outputTokens: 0 },
          },
        },
      },
      undefined,
      { status: "cancelled" },
    );
    expect(charged()?.costUsd).toBe(1);
  });

  it("never charges more than the hold", async () => {
    await reconcile({
      usage: { ...stopped, countedTokens: { inputTokens: 0, outputTokens: 1_000_000 } },
    });
    expect(charged()?.costUsd).toBe(1);
  });

  it("releases the hold of a call that never reached the provider", async () => {
    await reconcile({
      usage: { ...stopped, providerRequestId: null, countedTokens: undefined },
    });
    expect(charged()).toMatchObject({ costUsd: 0, costSource: "reconciled-estimate" });
  });

  it("lets a call without a receipt finish before releasing its hold", async () => {
    await reconcile({ reconciliationAttempts: 4 });
    expect(recordUsage).not.toHaveBeenCalled();
    await reconcile({ reconciliationAttempts: 5 });
    expect(charged()).toMatchObject({ costUsd: 0, inputTokens: null, outputTokens: null });
  });

  it("flags an unfinished paid service call for review instead of releasing its hold", async () => {
    const updateMany = await reconcile({ provider: "services", reconciliationAttempts: 5 });
    expect(recordUsage).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "entry-1", reconciliationState: "pending" },
      data: { reconciliationState: "needs_review", nextReconcileAt: null },
    });
  });

  it("keeps holding a call without a receipt while its run is still live", async () => {
    const updateMany = await reconcile({ reconciliationAttempts: 5 }, undefined, {
      status: "running",
      leaseExpiresAt: new Date(60_000),
    });
    expect(recordUsage).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reconciliationState: "pending" }),
      }),
    );
    await reconcile({ reconciliationAttempts: 5 }, undefined, {
      status: "running",
      leaseExpiresAt: new Date(-1),
    });
    expect(charged()).toMatchObject({ costUsd: 0 });
  });

  it("reports why the provider could not price a call", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    await reconcile(
      { usage: stopped, providerRequestId: "gen-fixture", reconciliationAttempts: 5 },
      lookup(async () => null),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        message: "Model credit hold settled without a provider cost",
        reason: "provider has no usage for the request",
      }),
    );
  });

  it("flags a hold it cannot attribute for review with the reason", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));

    const updateMany = await reconcile({ model: null, reconciliationAttempts: 5 });

    expect(recordUsage).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "entry-1", reconciliationState: "pending" },
      data: { reconciliationState: "needs_review", nextReconcileAt: null },
    });
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Model credit hold requires review",
        callId: "call-1",
        reason: "Legacy reservation requires manual attribution",
        attempts: 6,
        hasProviderRequestId: false,
        canLookUpUsage: false,
      }),
    );
  });

  it("keeps the failure reason on each attempt that could not verify a call", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    await reconcile({ model: null });

    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "Model credit reconciliation could not verify a call",
        reason: "Legacy reservation requires manual attribution",
      }),
    ]);
  });
});
