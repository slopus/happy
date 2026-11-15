import type { AdapterContext, PaidService } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createPaidServiceProvider, FakePaidServiceProvider } from "./paid-services-factory.js";
import { TregPaidServiceProvider } from "./treg-paid-services.js";

const context = { signal: new AbortController().signal } as AdapterContext;

const routed = {
  id: "treg.google.serp.maps",
  name: "google.serp.maps — routed: best of 5 providers, own keys first",
  summary: "Google Maps places for a keyword",
  kind: "routed",
  scope: "",
  method: "POST",
  platform: "google",
  platform_eligible: true,
  async: null,
  capability_description: "Get Google Maps results for a keyword and location",
  cost: { usd: 0.00015, type: "per_success", varies: true },
  input: {
    bodyType: "json",
    body: { q: { type: "str", required: false, note: "treg sends each provider the query" } },
    note: "Options are X-Treg-Route-* headers",
  },
};
const direct = {
  id: "scrapecreators.x.user.posts",
  name: "X (Twitter) user tweets by username",
  summary: "Recent tweets",
  kind: "data",
  scope: "any_account",
  method: "GET",
  platform: "x",
  cost: { usd: 0.00188, type: "per_call" },
  input: {
    queryParams: { handle: { type: "string", required: true, example: "example_handle" } },
    pathParams: { id: { type: "string", required: true } },
  },
};
const blocked = [
  { ...direct, id: "linkedin.post.create", kind: "action", method: "POST" },
  { ...direct, id: "meta-ads.campaigns", scope: "own_account" },
  { ...direct, id: "ads.unlabeled", scope: undefined },
  { ...direct, id: "ads.future", scope: "team_connection" },
  { ...direct, id: "auto.google.serp.maps" },
  { ...direct, id: "replicate.flux", async: { poll: {} } },
  { ...direct, id: "minimax.image", platform: "image-gen" },
  { ...direct, id: "hunter.recipients.remove", method: "DELETE" },
];

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function provider(respond: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  return {
    fetchMock,
    services: new TregPaidServiceProvider({
      apiKey: "fake-token",
      baseUrl: "https://catalog.example.test",
      fetch: fetchMock as typeof fetch,
    }),
  };
}

const mapsService: PaidService = {
  id: "auto.google.serp.maps",
  name: "Maps",
  description: "",
  priceUsd: 0.00015,
  priceVaries: true,
  method: "POST",
  params: {},
};
const callOptions = { idempotencyKey: "key-1", customer: "org_1", maxCostUsd: 0.25 };

describe("TregPaidServiceProvider", () => {
  it("lists only callable lookups, under neutral names and ids", async () => {
    const { services, fetchMock } = provider(() =>
      json({ results: [routed, direct, ...blocked], hints: ["treg call treg.google.serp.maps"] }),
    );
    const found = await services.search("google maps", context);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://catalog.example.test/catalog/search?q=google+maps&limit=25",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("X-Treg-Token");
    expect(found.map((service) => service.id)).toEqual([
      "auto.google.serp.maps",
      "scrapecreators.x.user.posts",
    ]);
    expect(found[0]).toMatchObject({
      name: "Get Google Maps results for a keyword and location",
      priceUsd: 0.00015,
      priceVaries: true,
      method: "POST",
      params: { body: { q: { type: "str", note: "the service sends each provider the query" } } },
    });
    expect(found[1]).toMatchObject({
      priceVaries: false,
      method: "GET",
      params: {
        query: {
          id: { type: "string", required: true },
          handle: { type: "string", required: true, example: "example_handle" },
        },
      },
    });
    expect(JSON.stringify(found)).not.toMatch(/treg/i);
  });

  it("keeps long parameter text out of the bot's context", async () => {
    const long = "x".repeat(5_000);
    const { services } = provider(() =>
      json({
        results: [
          {
            ...direct,
            input: { queryParams: { handle: { type: long, note: long, example: long } } },
          },
        ],
      }),
    );
    const [found] = await services.search("x", context);
    expect(found?.params?.query?.handle).toEqual({ type: "x".repeat(40), note: "x".repeat(300) });
  });

  it("leaves out services whose id it could not look up again", async () => {
    const { services } = provider(() =>
      json({ results: [{ ...direct, id: "service/name" }, direct] }),
    );
    expect((await services.search("profile", context)).map((service) => service.id)).toEqual([
      direct.id,
    ]);
  });

  it("describes a routed service by its public id and refuses ones it cannot call", async () => {
    const { services, fetchMock } = provider((url) =>
      url.endsWith("/treg.google.serp.maps")
        ? json({ endpoint: routed })
        : url.endsWith("/linkedin.post.create")
          ? json({ endpoint: blocked[0] })
          : new Response("missing", { status: 404 }),
    );
    expect((await services.describe("auto.google.serp.maps", context))?.id).toBe(
      "auto.google.serp.maps",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://catalog.example.test/catalog/endpoints/treg.google.serp.maps",
    );
    expect(await services.describe("linkedin.post.create", context)).toBeNull();
    expect(await services.describe("nobody.knows", context)).toBeNull();
    expect(await services.describe("../escape", context)).toBeNull();
  });

  it("sends the token, customer tag, ceiling and idempotency key, and reads the charge", async () => {
    const { services, fetchMock } = provider(() =>
      json(
        {
          output: { places: [{ name: "Cafe" }] },
          raw: { huge: true },
          _treg: {
            served_by: "crawl4ai",
            advice: "treg verified it",
            charged_micro: 150,
            details: { charged_micro: 150, tried: [{ provider: "a", cost_usd: 0.1 }] },
          },
        },
        200,
        { "X-Treg-Cost-Micro": "150", "X-Treg-Call-Id": "call-9" },
      ),
    );
    const result = await services.call(
      mapsService,
      { query: { country: "us" }, body: { q: "coffee" } },
      { ...callOptions, customer: "org 1/évil" },
      context,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://catalog.example.test/call/treg.google.serp.maps?country=us");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ q: "coffee" }));
    expect(init?.headers).toMatchObject({
      "X-Treg-Token": "fake-token",
      "X-Treg-Meta": "customer=org1vil",
      "X-Treg-Route-Max-Cost": "0.250000",
      "Idempotency-Key": "key-1",
    });
    expect(result).toEqual({
      outcome: "answered",
      ok: true,
      status: 200,
      data: {
        output: { places: [{ name: "Cafe" }] },
        routing: {
          served_by: "crawl4ai",
          advice: "the service verified it",
          details: { tried: [{ provider: "a" }] },
        },
      },
      costUsd: 0.00015,
      providerCallId: "call-9",
    });
  });

  it("answers a deeply nested routing record without overflowing", async () => {
    const depth = 5_000;
    // Written as text: building it with JSON.stringify would itself overflow a small stack.
    const routing = `${'{"next":'.repeat(depth)}{"served_by":"a"}${"}".repeat(depth)}`;
    const { services } = provider(
      () =>
        new Response(`{"output":{"ok":true},"_treg":${routing}}`, {
          headers: { "content-type": "application/json", "X-Treg-Cost-Micro": "150" },
        }),
    );
    const result = await services.call(
      mapsService,
      { body: { q: "coffee" } },
      callOptions,
      context,
    );
    expect(result).toMatchObject({ outcome: "answered", ok: true, costUsd: 0.00015 });
  });

  it("bills a replay at the first call's charge", async () => {
    const { services } = provider(() =>
      json({ ok: true }, 200, {
        "X-Treg-Cost-Micro": "0",
        "X-Treg-Original-Cost-Micro": "4200",
      }),
    );
    expect(await services.call(mapsService, {}, callOptions, context)).toMatchObject({
      costUsd: 0.0042,
    });
  });

  it("relays a provider error with its cost, and an unbilled one as free", async () => {
    const { services } = provider(() => json({ message: "bad handle" }, 400));
    expect(await services.call(mapsService, {}, callOptions, context)).toMatchObject({
      outcome: "answered",
      ok: false,
      status: 400,
      data: { message: "bad handle" },
      costUsd: 0,
    });
  });

  it("never passes on account-level refusals", async () => {
    const { services } = provider(() =>
      json(
        {
          error: "insufficient_balance",
          balance_micro: 12,
          topup_url: "https://catalog.example.test/topup",
        },
        402,
        { "X-Treg-Error": "1" },
      ),
    );
    const result = await services.call(mapsService, {}, callOptions, context);
    expect(result).toEqual({ outcome: "refused", reason: "unavailable" });
  });

  it("refuses account errors without the error header and ignores unsafe charges", async () => {
    const answers = [
      json({ error: "insufficient_balance", topup_url: "https://catalog.example.test/topup" }, 402),
      json({ ok: true }, 200, { "X-Treg-Cost-Micro": "9".repeat(30) }),
    ];
    const { services } = provider(() => answers.shift()!);
    expect(await services.call(mapsService, {}, callOptions, context)).toEqual({
      outcome: "refused",
      reason: "unavailable",
    });
    expect(await services.call(mapsService, {}, callOptions, context)).toMatchObject({
      costUsd: 0,
    });
  });

  it("only sends its token over https, or plain http to this machine", () => {
    expect(
      () => new TregPaidServiceProvider({ apiKey: "k", baseUrl: "http://catalog.example.test" }),
    ).toThrow();
    expect(
      () => new TregPaidServiceProvider({ apiKey: "k", baseUrl: "http://localhost:8080" }),
    ).not.toThrow();
  });

  it("maps the ceiling refusal, input refusals and a failed waterfall", async () => {
    const answers = [
      json({ error: "route_max_cost" }, 402, { "X-Treg-Error": "1" }),
      json({ error: "invalid_identity", message: "treg refused linkedin_url: N/A" }, 422, {
        "X-Treg-Error": "1",
      }),
      json({ error: "route_failed", charged_micro: 300, tried: ["a", "b"] }, 502, {
        "X-Treg-Error": "1",
      }),
    ];
    const { services } = provider(() => answers.shift()!);
    expect(await services.call(mapsService, {}, callOptions, context)).toEqual({
      outcome: "refused",
      reason: "over_max_cost",
    });
    expect(await services.call(mapsService, {}, callOptions, context)).toEqual({
      outcome: "refused",
      reason: "invalid_input",
      message: "the service refused linkedin_url: N/A",
    });
    expect(await services.call(mapsService, {}, callOptions, context)).toMatchObject({
      outcome: "answered",
      ok: false,
      costUsd: 0.0003,
    });
  });

  it("reports an answer too large to read as a failure", async () => {
    const { services } = provider(
      () =>
        new Response("x".repeat(3_000_000), {
          status: 200,
          headers: { "X-Treg-Cost-Micro": "500" },
        }),
    );
    expect(await services.call(mapsService, {}, callOptions, context)).toMatchObject({
      outcome: "answered",
      ok: false,
      costUsd: 0.0005,
    });
  });

  it("never passes an account error's message to the bot", async () => {
    const { services } = provider(() =>
      json(
        { error: "insufficient_balance", message: "Balance $0.12, top up at a billing link" },
        400,
      ),
    );
    expect(await services.call(mapsService, {}, callOptions, context)).toEqual({
      outcome: "refused",
      reason: "unavailable",
    });
  });

  it("bills a refusal that carries a charge", async () => {
    const answers = [
      json({ error: "invalid_identity" }, 422, { "X-Treg-Error": "1", "X-Treg-Cost-Micro": "400" }),
      new Response("not json", {
        status: 502,
        headers: { "X-Treg-Error": "1", "X-Treg-Cost-Micro": "300" },
      }),
    ];
    const { services } = provider(() => answers.shift()!);
    expect(await services.call(mapsService, {}, callOptions, context)).toMatchObject({
      outcome: "answered",
      ok: false,
      costUsd: 0.0004,
    });
    expect(await services.call(mapsService, {}, callOptions, context)).toMatchObject({
      outcome: "answered",
      ok: false,
      costUsd: 0.0003,
    });
  });

  it("throws when the call may still finish and charge", async () => {
    const answers = [
      json({ _treg: { outcome: "pending" } }, 202),
      json({ error: "idempotency_outcome_unknown" }, 410, { "X-Treg-Error": "1" }),
      json({ error: "idempotency_outcome_unknown" }, 410),
    ];
    const { services } = provider(() => answers.shift()!);
    await expect(services.call(mapsService, {}, callOptions, context)).rejects.toThrow();
    await expect(services.call(mapsService, {}, callOptions, context)).rejects.toThrow();
    await expect(services.call(mapsService, {}, callOptions, context)).rejects.toThrow();
  });
});

describe("createPaidServiceProvider", () => {
  it("is off unless configured, and needs a key for the real provider", () => {
    expect(createPaidServiceProvider({})).toBeUndefined();
    expect(createPaidServiceProvider({ PAID_SERVICES_PROVIDER: "disabled" })).toBeUndefined();
    expect(createPaidServiceProvider({ PAID_SERVICES_PROVIDER: "fake" })).toBeInstanceOf(
      FakePaidServiceProvider,
    );
    expect(() => createPaidServiceProvider({ PAID_SERVICES_PROVIDER: "treg" })).toThrow("API key");
    expect(
      createPaidServiceProvider({
        PAID_SERVICES_PROVIDER: "treg",
        PAID_SERVICES_API_KEY: "fake-token",
      }),
    ).toBeInstanceOf(TregPaidServiceProvider);
    expect(() => createPaidServiceProvider({ PAID_SERVICES_PROVIDER: "other" })).toThrow();
  });
});
