import type { OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "./model-secret.js";
import {
  PlanLimitsReader,
  parseChatGptPlanLimits,
  parseClaudePlanLimits,
  readMemberPlanLimits,
} from "./plan-limits.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: NOW + 3_600_000,
    ...overrides,
  } as OAuthCredential;
}

const claudeBody = {
  five_hour: { utilization: 42, resets_at: "2026-11-10T15:00:00Z" },
  seven_day: { utilization: 12.5, resets_at: "2026-11-14T00:00:00Z" },
  seven_day_opus: { utilization: 90, resets_at: "2026-11-14T00:00:00Z" },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("parseClaudePlanLimits", () => {
  it("reads the shared session and weekly windows and skips per-model ones", () => {
    expect(parseClaudePlanLimits(claudeBody)).toEqual([
      { period: "session", usedPercent: 42, resetsAt: "2026-11-10T15:00:00.000Z" },
      { period: "week", usedPercent: 12.5, resetsAt: "2026-11-14T00:00:00.000Z" },
    ]);
  });

  it("leaves out a window the plan does not have", () => {
    expect(
      parseClaudePlanLimits({ five_hour: { utilization: 3, resets_at: null }, seven_day: null }),
    ).toEqual([{ period: "session", usedPercent: 3, resetsAt: null }]);
  });
});

describe("parseChatGptPlanLimits", () => {
  it("names each window by its length", () => {
    expect(
      parseChatGptPlanLimits({
        rate_limit: {
          primary_window: {
            used_percent: 7,
            limit_window_seconds: 18_000,
            reset_at: 1_794_326_400,
          },
          secondary_window: { used_percent: 120, limit_window_seconds: 604_800, reset_at: null },
        },
      }),
    ).toEqual([
      { period: "session", usedPercent: 7, resetsAt: "2026-11-10T16:00:00.000Z" },
      { period: "week", usedPercent: 100, resetsAt: null },
    ]);
  });

  it("rejects a body without rate limits", () => {
    expect(() => parseChatGptPlanLimits({})).toThrow();
  });
});

describe("PlanLimitsReader", () => {
  it("reuses a recent reading instead of asking the provider again", async () => {
    let now = NOW;
    const fetchImpl = vi.fn(async () => json(claudeBody));
    const reader = new PlanLimitsReader(fetchImpl as typeof fetch, () => now);
    await reader.read("k", "anthropic", credential());
    now += 30_000;
    const again = await reader.read("k", "anthropic", credential());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(again?.[0]?.usedPercent).toBe(42);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer access-token");
  });

  it("keeps the last good reading when a later read fails", async () => {
    let now = NOW;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(claudeBody))
      .mockResolvedValueOnce(json({ error: "nope" }, 500));
    const reader = new PlanLimitsReader(fetchImpl as typeof fetch, () => now);
    await reader.read("k", "anthropic", credential());
    now += 120_000;
    expect(await reader.read("k", "anthropic", credential())).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reads nothing for a provider without an allowance or an expired token", async () => {
    const fetchImpl = vi.fn();
    const reader = new PlanLimitsReader(fetchImpl as typeof fetch, () => NOW);
    expect(await reader.read("a", "openrouter", credential())).toBeNull();
    expect(await reader.read("b", "anthropic", credential({ expires: NOW - 1 }))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("needs the ChatGPT account the sign-in belongs to", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000 } },
      }),
    );
    const reader = new PlanLimitsReader(fetchImpl as typeof fetch, () => NOW);
    expect(await reader.read("a", "openai-codex", credential())).toBeNull();
    const signedIn = credential({ accountId: "acct-1" } as Partial<OAuthCredential>);
    expect(await reader.read("b", "openai-codex", signedIn)).toEqual([
      { period: "session", usedPercent: 5, resetsAt: null },
    ]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["chatgpt-account-id"]).toBe("acct-1");
  });
});

describe("readMemberPlanLimits", () => {
  it("lists subscription sign-ins and skips API keys and connections to reconnect", async () => {
    const rows = [
      { id: "c1", provider: "anthropic", label: "me@example.com", secretId: "s1" },
      { id: "c2", provider: "anthropic", label: "Anthropic key", secretId: "s2" },
      { id: "c3", provider: "openai-codex", label: "ChatGPT", secretId: "s3" },
    ];
    const plaintext: Record<string, string> = {
      s1: serializeModelSecret({ kind: "oauth", credential: credential() }),
      s2: serializeModelSecret({ kind: "api_key", key: "sk-test" }),
      s3: serializeModelSecret({ kind: "oauth", reconnectRequired: true }),
    };
    const prisma = {
      userModelCredential: { findMany: vi.fn(async () => rows) },
      secret: {
        findMany: vi.fn(async () =>
          rows.map((row) => ({ id: row.secretId, ciphertext: row.secretId })),
        ),
      },
    };
    const reader = new PlanLimitsReader((async () => json(claudeBody)) as typeof fetch, () => NOW);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const plans = await readMemberPlanLimits(
      prisma as never,
      { load: async (ciphertext: string) => plaintext[ciphertext]! },
      "u1",
      reader,
      vi.fn(),
    );
    vi.restoreAllMocks();
    expect(plans).toEqual([
      {
        credentialId: "c1",
        name: "Claude",
        label: "me@example.com",
        windows: parseClaudePlanLimits(claudeBody),
      },
    ]);
  });

  it("starts a refresh for an expired sign-in", async () => {
    const rows = [{ id: "c1", provider: "anthropic", label: "Claude", secretId: "s1" }];
    const prisma = {
      userModelCredential: { findMany: vi.fn(async () => rows) },
      secret: { findMany: vi.fn(async () => [{ id: "s1", ciphertext: "x" }]) },
    };
    const expired = serializeModelSecret({
      kind: "oauth",
      credential: credential({ expires: 1 }),
    });
    const onExpired = vi.fn();
    const plans = await readMemberPlanLimits(
      prisma as never,
      { load: async () => expired },
      "u1",
      new PlanLimitsReader(vi.fn() as never),
      onExpired,
    );
    expect(plans).toEqual([]);
    expect(onExpired).toHaveBeenCalledWith("s1", "anthropic");
  });
});
