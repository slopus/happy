import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "./model-choice.js";
import { matchModelChoice, resolveModelChoice, words } from "./model-choice.js";

const choice = (provider: string, providerName: string, id: string, label: string) => ({
  provider,
  providerName,
  id,
  label,
});

const choices: ModelChoice[] = [
  choice("anthropic", "Anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
  choice("anthropic", "Anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
  choice("anthropic", "Anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5"),
  choice("openrouter", "OpenRouter", "anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5"),
  choice("google", "Google", "gemini-3.7-flash", "Gemini 3.7 Flash"),
  choice("google", "Google", "gemini-3.8-flash", "Gemini 3.8 Flash"),
  choice("google", "Google", "gemini-3.8-flash-lite", "Gemini 3.8 Flash Lite"),
];

const matched = (query: string, preferred?: string) => {
  const { match } = matchModelChoice(choices, query, preferred);
  return match && `${match.provider}/${match.id}`;
};

describe("matchModelChoice", () => {
  it("matches exact ids, with or without the provider", () => {
    expect(matched("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(matched("OpenRouter/anthropic/claude-sonnet-5.5")).toBe(
      "openrouter/anthropic/claude-sonnet-5.5",
    );
  });

  it("reads a loose name as the newest plain model of that family", () => {
    expect(matched("Claude Sonnet")).toBe("anthropic/claude-sonnet-5-5");
    expect(matched("gemini flash")).toBe("google/gemini-3.8-flash");
    expect(matched("Gemini Flash Lite")).toBe("google/gemini-3.8-flash-lite");
  });

  it("keeps a spoken version exact", () => {
    expect(matched("sonnet 5")).toBe("anthropic/claude-sonnet-5");
    expect(matched("Gemini 3.7 Flash")).toBe("google/gemini-3.7-flash");
  });

  it("prefers the bot's current provider", () => {
    expect(matched("Claude Sonnet", "openrouter")).toBe("openrouter/anthropic/claude-sonnet-5.5");
  });

  it("returns ranked candidates instead of guessing between equal matches", () => {
    const twins = [
      choice("google", "Google", "gemini-3.8-flash", "Gemini 3.8 Flash"),
      choice("google-vertex", "Vertex", "gemini-3.8-flash", "Gemini 3.8 Flash"),
    ];
    const { match, ranked } = matchModelChoice(twins, "Gemini 3.8 Flash");
    expect(match).toBeUndefined();
    expect(ranked).toHaveLength(2);
  });

  it("matches nothing for an unknown name", () => {
    expect(matchModelChoice(choices, "llama").ranked).toEqual([]);
  });
});

describe("hyphenated versions in ids", () => {
  it.each([
    ["claude-sonnet-5-5", ["claude", "sonnet", "5.5"]],
    ["gemini-2-0-flash", ["gemini", "2.0", "flash"]],
    ["claude-sonnet-4-5-20250929", ["claude", "sonnet", "4.5", "20250929"]],
    ["llama-3-1-8b", ["llama", "3.1", "8", "b"]],
    ["llama-3-8b", ["llama", "3", "8", "b"]],
    ["gpt-4-1106-preview", ["gpt", "4", "1106", "preview"]],
    ["gpt-4-0613", ["gpt", "4", "0613"]],
    ["o3-mini", ["o", "3", "mini"]],
    ["model-2026-11-05", ["model", "2026", "11", "05"]],
    ["gemini-2.5-flash-preview-05-20", ["gemini", "2.5", "flash", "preview", "05", "20"]],
    ["model-1-2-3", ["model", "1", "2", "3"]],
    ["deepseek-v3-1", ["deepseek", "v", "3.1"]],
    ["meta.llama3-1-8b", ["meta", "llama", "3.1", "8", "b"]],
    ["gemini-2-5-pro-preview-11-20", ["gemini", "2.5", "pro", "preview", "11", "20"]],
    ["gpt-4o-2024-11-20", ["gpt", "4", "o", "2024", "11", "20"]],
  ])("reads %s as %j", (id, expected) => {
    expect(words(id)).toEqual(expected);
  });

  // Custom servers list models by id alone, so the id is the label.
  const ids = [
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-sonnet-4-5-20250929",
    "llama-3-1-8b",
    "llama-3-8b",
    "ministral-3-8b",
  ].map((id) => choice("openai-compatible", "OpenAI-compatible", id, id));
  const matchedId = (query: string) => matchModelChoice(ids, query).match?.id;

  it.each(["sonnet5.5", "Sonnet 5.5", "claude sonnet 5.5", "sonnet 5-5"])(
    "matches %s to claude-sonnet-5-5",
    (query) => {
      expect(matchedId(query)).toBe("claude-sonnet-5-5");
    },
  );

  it("keeps a spoken version exact and prefers the newest for a bare family", () => {
    expect(matchedId("sonnet 5")).toBe("claude-sonnet-5");
    expect(matchedId("sonnet 4.5")).toBe("claude-sonnet-4-5-20250929");
    expect(matchedId("sonnet")).toBe("claude-sonnet-5-5");
    expect(matchedId("llama 3.1")).toBe("llama-3-1-8b");
    expect(matchedId("llama 3")).toBe("llama-3-8b");
    // Spaced numbers stay apart, as they do against catalog labels: "3 8" is a size here.
    expect(matchedId("ministral 3 8")).toBe("ministral-3-8b");
  });
});

function connected(providers: string[]) {
  const credentials = providers.map((provider) => ({
    id: `cred-${provider}`,
    provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  const prisma = {
    userModelCredential: { findMany: vi.fn(async () => credentials) },
    userModelPreference: { findMany: vi.fn(async () => []) },
    secret: {
      findMany: vi.fn(async () =>
        credentials.map((credential) => ({ id: credential.secretId, ciphertext: "fake" })),
      ),
    },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    secretStore: { load: async () => "fake-api-key" },
  };
}

const scope = { userId: "user-1", spaceId: "space-1" };

describe("resolveModelChoice", () => {
  it("resolves a loose name against the connected providers' models", async () => {
    expect(
      await resolveModelChoice(connected(["google"]), scope, { model: "gemini flash" }),
    ).toEqual({ ok: true, provider: "google", model: "gemini-3.8-flash" });
  });

  it("names the provider to connect when only another provider has the model", async () => {
    const result = await resolveModelChoice(connected(["google"]), scope, {
      model: "Claude Sonnet",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/connect .*Anthropic.* in Settings first/),
    });
  });

  it("passes an exact provider/id through for the model check to judge", async () => {
    expect(
      await resolveModelChoice(connected(["google"]), scope, { model: "google/gemini-live-x" }),
    ).toEqual({ ok: true, provider: "google", model: "gemini-live-x" });
  });

  it("says when no model anywhere matches", async () => {
    expect(await resolveModelChoice(connected([]), scope, { model: "zzz-unknown" })).toEqual({
      ok: false,
      error: 'No model matches "zzz-unknown".',
    });
  });

  it("bounds the echoed query in errors", async () => {
    const elsewhere = await resolveModelChoice(connected(["google"]), scope, {
      model: `${"claude ".repeat(10_000)}sonnet`,
    });
    expect(elsewhere).toMatchObject({ ok: false });
    if (!elsewhere.ok) {
      expect(elsewhere.error).toContain("No connected model matches");
      expect(elsewhere.error.length).toBeLessThan(600);
    }
    const nowhere = await resolveModelChoice(connected([]), scope, {
      model: "z".repeat(60_000),
    });
    expect(nowhere).toMatchObject({ ok: false });
    if (!nowhere.ok) expect(nowhere.error.length).toBeLessThan(400);
  });
});
