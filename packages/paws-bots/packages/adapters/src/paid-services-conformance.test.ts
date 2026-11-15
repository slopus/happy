import type { AdapterContext, PaidServiceProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakePaidServiceProvider } from "./paid-services-factory.js";
import { TregPaidServiceProvider } from "./treg-paid-services.js";

const context = { signal: new AbortController().signal } as AdapterContext;

const endpoint = {
  id: "maps.places",
  name: "Map places",
  summary: "Places for a keyword",
  kind: "data",
  scope: "any_account",
  method: "POST",
  platform: "google",
  capability_description: "Map places for a keyword",
  cost: { usd: 0.002, type: "per_call" },
  input: { bodyType: "json", body: { q: { type: "string", required: true } } },
};

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
}

const tregWire = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/catalog/search")) return json({ results: [endpoint] });
  if (url.endsWith("/catalog/endpoints/maps.places")) return json({ endpoint });
  if (url.includes("/call/maps.places"))
    return json({ output: { places: [] } }, { "X-Treg-Cost-Micro": "2000" });
  return new Response("missing", { status: 404 });
}) as typeof fetch;

const providers: Array<[string, () => PaidServiceProvider]> = [
  ["fake", () => new FakePaidServiceProvider()],
  [
    "treg (offline wire)",
    () =>
      new TregPaidServiceProvider({
        apiKey: "fake-token",
        baseUrl: "https://catalog.example.test",
        fetch: tregWire,
      }),
  ],
];

describe.each(providers)("paid service provider conformance: %s", (_name, create) => {
  it("finds a service it can describe and call, and bills the answer", async () => {
    const provider = create();
    const [found] = await provider.search("map places", context);
    expect(found).toBeDefined();
    const described = await provider.describe(found!.id, context);
    expect(described?.id).toBe(found!.id);
    const result = await provider.call(
      described!,
      { body: { q: "coffee" } },
      { idempotencyKey: "key-1", customer: "org_1", maxCostUsd: 0.25 },
      context,
    );
    expect(result).toMatchObject({ outcome: "answered", ok: true });
    expect(result.outcome === "answered" && result.costUsd).toBeCloseTo(0.002);
  });

  it("describes an unknown service as null", async () => {
    expect(await create().describe("nobody.knows", context)).toBeNull();
  });
});
