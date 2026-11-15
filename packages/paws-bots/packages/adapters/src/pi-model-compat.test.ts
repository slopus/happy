import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { applyPiModelCompatibility } from "./pi-model-compat.js";

// Observed: 400 "minijinja: rendering failed: raise_exception: Unexpected message role."
// Qwen-style chat templates only render system, user, assistant and tool.
it.each([
  ["groq", "openai/gpt-oss-20b"],
  ["groq", "openai/gpt-oss-120b"],
  ["groq", "qwen/qwen3.6-27b"],
  ["xiaomi", "mimo-v2.6-flash"],
])("sends system instructions to the %s %s chat template", async (provider, id) => {
  const models = applyPiModelCompatibility(builtinModels());
  const model = models.getModel(provider, id);
  expect(model).toBeDefined();
  if (!model) return;
  let roles: string[] = [];
  const result = await models
    .streamSimple(
      model,
      {
        systemPrompt: "Fixture instructions.",
        messages: [{ role: "user", content: "Fixture request.", timestamp: 1 }],
      },
      {
        apiKey: "fixture-key",
        reasoning: "low",
        maxRetries: 0,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
          roles = body.messages.map((message) => message.role);
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    )
    .result();
  expect(result.stopReason).toBe("stop");
  expect(roles).toEqual(["system", "user"]);
});

describe("provider compatibility boundaries", () => {
  it("keeps other providers unchanged", () => {
    const original = builtinModels();
    const openai = original.getProvider("openai");
    expect(openai).toBeDefined();
    expect(applyPiModelCompatibility(original).getProvider("openai")).toBe(openai);
  });
});
