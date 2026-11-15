import { expect, it } from "vitest";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";

it("exposes Ollama models through the compatible fixture while authenticating balance requests", async () => {
  const transport = createModelConnectionFixtureFetch([]);
  const models = await transport("https://ollama.com/v1/models");
  expect(await models.json()).toEqual({ data: [{ id: "fixture-model" }] });
  for (const [key, status] of [
    ["rejected-fixture-key", 401],
    ["fake-fixture-key", 200],
  ] as const) {
    const response = await transport("https://ollama.com/api/balance", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(status);
  }
});
