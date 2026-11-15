import type { AdapterContext, PaidServiceProvider } from "@rakazo/adapter-kit";
import {
  organizationForMember,
  recordModelCreditReceipt,
  recordUsage,
  reserveModelCredits,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serviceCallFromTool, serviceSearchFromTool } from "./paid-service-tools.js";
import { FakePaidServiceProvider } from "./paid-services-factory.js";

vi.mock("@rakazo/db", () => ({
  organizationForMember: vi.fn(),
  reserveModelCredits: vi.fn(),
  recordModelCreditReceipt: vi.fn(),
  recordUsage: vi.fn(),
}));

const context = { signal: new AbortController().signal } as AdapterContext;
const scope = { userId: "user-1", spaceId: "space-1", runId: "run-1", botId: "bot-1" };
const prisma = {} as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(organizationForMember).mockResolvedValue({ organizationId: "org-1" } as never);
  vi.mocked(reserveModelCredits).mockResolvedValue("hold-1");
});

describe("service_search", () => {
  it("shows hosted prices with the markup and self-hosted prices at cost", async () => {
    const provider = new FakePaidServiceProvider();
    const hosted = await serviceSearchFromTool(provider, context, { query: "email" }, true);
    expect(hosted).toEqual({
      services: [expect.objectContaining({ id: "people.email", price_usd: 0.006 })],
    });
    const selfHosted = await serviceSearchFromTool(provider, context, { query: "email" }, false);
    expect(selfHosted).toEqual({
      services: [expect.objectContaining({ id: "people.email", price_usd: 0.005 })],
    });
  });

  it("leaves out services whose price is over the per-call cap", async () => {
    const provider = new FakePaidServiceProvider();
    const [email] = await provider.search("email");
    vi.spyOn(provider, "search").mockResolvedValue([{ ...email!, priceUsd: 1.8 }]);
    expect(await serviceSearchFromTool(provider, context, { query: "email" }, true)).toEqual({
      services: [],
    });
    expect(await serviceSearchFromTool(provider, context, { query: "email" }, false)).toMatchObject(
      { services: [{ id: "people.email" }] },
    );
  });

  it("fills its ten results from affordable services further down the list", async () => {
    const provider = new FakePaidServiceProvider();
    const [email] = await provider.search("email");
    const expensive = Array.from({ length: 10 }, (_, i) => ({
      ...email!,
      id: `pricey.${i}`,
      priceUsd: 5,
    }));
    vi.spyOn(provider, "search").mockResolvedValue([...expensive, email!]);
    expect(await serviceSearchFromTool(provider, context, { query: "email" }, true)).toMatchObject({
      services: [{ id: "people.email" }],
    });
  });
});

describe("service_call", () => {
  it("rejects an oversized query before holding credits", async () => {
    const query = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, "x".repeat(2_000)]),
    );
    expect(
      await serviceCallFromTool(
        { prisma, provider: new FakePaidServiceProvider(), billing: true },
        scope,
        { service: "people.email", query, max_cost_usd: 0.05 },
        "run-1:service_call:big",
        context,
      ),
    ).toEqual({ error: "query is too large." });
    expect(reserveModelCredits).not.toHaveBeenCalled();
  });

  it("holds the ceiling, then settles to the provider's charge plus the markup", async () => {
    const provider = new FakePaidServiceProvider();
    const result = await serviceCallFromTool(
      { prisma, provider, billing: true },
      scope,
      {
        service: "people.email",
        query: { full_name: "Ada Example", domain: "example.test" },
        max_cost_usd: 0.05,
      },
      "run-1:service_call:abc",
      context,
    );
    expect(result).toMatchObject({ service: "Find a work email", cost_usd: 0.006 });
    const [, organizationId, maxUsd, attribution] = vi.mocked(reserveModelCredits).mock.calls[0]!;
    expect(organizationId).toBe("org-1");
    expect(maxUsd).toBe(0.05);
    expect(attribution).toMatchObject({
      provider: "services",
      model: "people.email",
      userId: "user-1",
      spaceId: "space-1",
      runId: "run-1",
    });
    const callId = attribution?.callId;
    expect(callId).toMatch(/^service:[0-9a-f]{64}$/);
    expect(provider.calls[0]?.idempotencyKey).toBe(callId?.slice("service:".length));
    expect(recordModelCreditReceipt).toHaveBeenCalledWith(
      prisma,
      "hold-1",
      expect.objectContaining({ costUsd: 0.006, costSource: "provider-reported" }),
    );
    expect(recordUsage).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        type: "usage",
        provider: "services",
        model: "people.email",
        callId,
        costUsd: 0.006,
        totalTokens: 0,
      }),
      expect.objectContaining({ spaceId: "space-1", userId: "user-1", botId: "bot-1" }),
    );
  });

  it("passes the agent's ceiling to the provider without the markup", async () => {
    const call = vi.fn(async () => ({
      outcome: "answered" as const,
      ok: true,
      status: 200,
      data: {},
      costUsd: 0.5,
    }));
    const provider: PaidServiceProvider = new FakePaidServiceProvider();
    provider.call = call;
    await serviceCallFromTool(
      { prisma, provider, billing: true },
      scope,
      { service: "maps.places", body: { q: "coffee" }, max_cost_usd: 1.2 },
      "key",
      context,
    );
    expect(vi.mocked(reserveModelCredits).mock.calls[0]?.[2]).toBe(1.2);
    expect(call.mock.calls[0]).toEqual([
      expect.objectContaining({ id: "maps.places" }),
      { body: { q: "coffee" } },
      expect.objectContaining({ maxCostUsd: 1, customer: "org-1" }),
      context,
    ]);
  });

  it("never charges more than the ceiling the agent agreed to", async () => {
    const provider = new FakePaidServiceProvider();
    provider.call = vi.fn(async () => ({
      outcome: "answered" as const,
      ok: true,
      status: 200,
      data: {},
      costUsd: 5,
    }));
    const result = await serviceCallFromTool(
      { prisma, provider, billing: true },
      scope,
      { service: "people.email", max_cost_usd: 0.1 },
      "key",
      context,
    );
    expect(result).toMatchObject({ cost_usd: 0.1 });
    expect(recordUsage).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ costUsd: 0.1 }),
      expect.anything(),
    );
  });

  it("tells the agent to add credits when the hold is refused", async () => {
    vi.mocked(reserveModelCredits).mockRejectedValue(
      new Error("Not enough model credits. Add credits in Billing or connect your own API key."),
    );
    const provider = new FakePaidServiceProvider();
    const result = await serviceCallFromTool(
      { prisma, provider, billing: true },
      scope,
      { service: "people.email", max_cost_usd: 0.05 },
      "key",
      context,
    );
    expect(result).toEqual({
      error: "Not enough credits for this service. Add credits in Billing.",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("releases the hold of a refused call", async () => {
    const provider = new FakePaidServiceProvider();
    provider.call = vi.fn(async () => ({
      outcome: "refused" as const,
      reason: "unavailable" as const,
    }));
    const result = await serviceCallFromTool(
      { prisma, provider, billing: true },
      scope,
      { service: "people.email", max_cost_usd: 0.05 },
      "key",
      context,
    );
    expect(result).toEqual({ error: "This service is unavailable right now. Try another one." });
    expect(recordModelCreditReceipt).toHaveBeenCalledWith(
      prisma,
      "hold-1",
      expect.objectContaining({ costUsd: 0, usageSource: "not-started" }),
    );
  });

  it("keeps the hold when the call may still be charged", async () => {
    const provider = new FakePaidServiceProvider();
    provider.call = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const result = await serviceCallFromTool(
      { prisma, provider, billing: true },
      scope,
      { service: "people.email", max_cost_usd: 0.05 },
      "key",
      context,
    );
    expect(result).toMatchObject({ error: expect.stringContaining("may still be charged") });
    expect(recordModelCreditReceipt).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("runs on the deployment account without credits when billing is off", async () => {
    const provider = new FakePaidServiceProvider();
    const result = await serviceCallFromTool(
      { prisma, provider, billing: false },
      scope,
      { service: "people.email", max_cost_usd: 0.05 },
      "key",
      context,
    );
    expect(result).toMatchObject({ cost_usd: 0.005 });
    expect(organizationForMember).not.toHaveBeenCalled();
    expect(reserveModelCredits).not.toHaveBeenCalled();
    expect(recordModelCreditReceipt).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ costUsd: 0.005 }),
      expect.anything(),
    );
  });

  it("refuses unknown services and bad arguments before holding anything", async () => {
    const provider = new FakePaidServiceProvider();
    const deps = { prisma, provider, billing: true };
    expect(
      await serviceCallFromTool(
        deps,
        scope,
        { service: "nope", max_cost_usd: 0.05 },
        "key",
        context,
      ),
    ).toMatchObject({ error: expect.stringContaining("Unknown service") });
    expect(
      await serviceCallFromTool(
        deps,
        scope,
        { service: "people.email", max_cost_usd: 50 },
        "key",
        context,
      ),
    ).toMatchObject({ error: expect.any(String) });
    expect(reserveModelCredits).not.toHaveBeenCalled();
  });
});
