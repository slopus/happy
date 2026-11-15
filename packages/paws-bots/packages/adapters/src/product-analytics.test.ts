import { AnalyticsEvent, AnalyticsScreenInput } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductAnalytics } from "./product-analytics.js";

const env = {
  ANALYTICS_PROVIDER: "posthog",
  ANALYTICS_KEY: "fake-project-token",
  ANALYTICS_PSEUDONYM_SECRET: "fake-server-only-pseudonym-secret",
  ANALYTICS_HOST: "https://collector.example.test",
};
afterEach(() => vi.useRealTimers());

describe("content-free product analytics", () => {
  it("is off by default and rejects incomplete or unsafe configuration", () => {
    const fetch = vi.fn();
    for (const config of [
      {},
      { ...env, ANALYTICS_PROVIDER: "none" },
      { ...env, ANALYTICS_KEY: "" },
      { ...env, ANALYTICS_PSEUDONYM_SECRET: "" },
      { ...env, ANALYTICS_HOST: "http://collector.example.test" },
      { ...env, ANALYTICS_HOST: "https://user:password@collector.example.test" },
    ]) {
      expect(createProductAnalytics(config, fetch)).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs events locally for the emulator without a key or network", async () => {
    const fetch = vi.fn();
    const analytics = createProductAnalytics({ ANALYTICS_PROVIDER: "emulator" }, fetch)!;
    analytics.capture("internal-user-id", { name: "signed_in" });
    await analytics.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      createProductAnalytics({ ANALYTICS_PROVIDER: "emulator", NODE_ENV: "production" }, fetch),
    ).toBeUndefined();
  });

  it("tags events with the variants of the running experiments", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const analytics = createProductAnalytics(env, fetch)!;
    analytics.capture("internal-user-id", { name: "signed_in" }, undefined, {
      "plan-layout": "tiers",
    });
    await analytics.flush();
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.batch[0].properties["$feature/plan-layout"]).toBe("tiers");
  });

  it("only exports an allowlisted event and a pseudonymous identity", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const analytics = createProductAnalytics(env, fetch)!;
    const identity = { id: "internal-message-id", at: new Date("2026-01-01T00:00:00Z") };
    analytics.capture("internal-user-id", { name: "message_sent", trigger: "user" }, identity);
    // Even a caller bypassing TypeScript cannot smuggle content or a new event through.
    analytics.capture("internal-user-id", {
      name: "message_sent",
      trigger: "user",
      prompt: "private content",
    } as never);
    analytics.capture("internal-user-id", { name: "private event" } as never);
    expect(() =>
      analytics.capture(
        "internal-user-id",
        { name: "signed_in" },
        { id: "bad-date", at: new Date("invalid") },
      ),
    ).not.toThrow();
    await analytics.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://collector.example.test/batch/");
    expect(init.redirect).toBe("error");
    const body = JSON.parse(init.body);
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]).toMatchObject({
      event: "message_sent",
      timestamp: identity.at.toISOString(),
      properties: {
        trigger: "user",
        source: "product",
        $geoip_disable: true,
        $process_person_profile: false,
      },
    });
    expect(body.batch[0].distinct_id).toMatch(/^product:[a-f0-9]{64}$/);
    expect(body.batch[0].uuid).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(init.body).not.toContain("internal-user-id");
    expect(init.body).not.toContain("internal-message-id");
    expect(init.body).not.toContain("private content");
    analytics.capture("internal-user-id", { name: "message_sent", trigger: "user" }, identity);
    await analytics.flush();
    expect(JSON.parse(fetch.mock.calls[1]![1].body).batch[0]).toEqual(body.batch[0]);
  });

  it("preserves identities across capture-token rotation without exporting its server secret", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null));
    const first = createProductAnalytics(env, fetch)!;
    const rotated = createProductAnalytics(
      { ...env, ANALYTICS_KEY: "rotated-fake-project-token" },
      fetch,
    )!;
    const identity = { id: "internal-event-id", at: new Date("2026-01-01T00:00:00Z") };
    first.capture("user-id", { name: "signed_in" }, identity);
    rotated.capture("user-id", { name: "signed_in" }, identity);
    await first.flush();
    await rotated.flush();
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0].api_key).not.toBe(bodies[1].api_key);
    expect(bodies[0].batch).toEqual(bodies[1].batch);
    for (const call of fetch.mock.calls)
      expect(call[1].body).not.toContain(env.ANALYTICS_PSEUDONYM_SECRET);
  });

  it("bounds queued events and contains collector failures", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("private collector response"));
    const analytics = createProductAnalytics(env, fetch)!;
    for (let i = 0; i < 300; i++) analytics.capture("user-id", { name: "signed_in" });
    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[0]![1].body).batch).toHaveLength(256);
  });

  it("delivers without a product request awaiting the collector", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(new Response(null));
    const analytics = createProductAnalytics(env, fetch)!;
    analytics.capture("user-id", { name: "screen_viewed", screen: "chat", surface: "ios" });
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await analytics.flush();
  });

  it("rejects URLs, identity fields, content, and unknown screens at the client boundary", () => {
    for (const screen of ["/app/private-id", "private title", "https://example.test"]) {
      expect(AnalyticsScreenInput.safeParse({ screen, surface: "web" }).success).toBe(false);
    }
    for (const key of ["email", "userId", "url", "text", "prompt", "properties"]) {
      expect(
        AnalyticsScreenInput.safeParse({ screen: "chat", surface: "web", [key]: "private" })
          .success,
      ).toBe(false);
    }
    expect(
      AnalyticsEvent.safeParse({
        name: "run_failed",
        trigger: "user",
        failure: "private provider error",
      }).success,
    ).toBe(false);
    expect(
      AnalyticsEvent.safeParse({
        name: "run_failed",
        trigger: "user",
        errorKind: "Invalid API key sk-private",
      }).success,
    ).toBe(false);
    for (const provider of ["https://private.example.test/v1", "My Gateway", ""]) {
      expect(
        AnalyticsEvent.safeParse({ name: "model_connected", method: "compatible", provider })
          .success,
      ).toBe(false);
    }
    expect(
      AnalyticsEvent.safeParse({ name: "model_connected", method: "api_key", provider: "openai" })
        .success,
    ).toBe(true);
  });
});
