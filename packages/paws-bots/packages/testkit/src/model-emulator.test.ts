import { afterEach, describe, expect, it } from "vitest";
import { startModelEmulator } from "./model-emulator.js";

const servers: Array<Awaited<ReturnType<typeof startModelEmulator>>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function post(server: Awaited<ReturnType<typeof startModelEmulator>>, overrides = {}) {
  return fetch(`${server.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer local", "content-type": "application/json" },
    body: JSON.stringify({
      model: server.model.id,
      stream: true,
      messages: [{ role: "user", content: "fixture" }],
      ...overrides,
    }),
  });
}

describe("model HTTP emulator contract", () => {
  it("fails locally when a request assertion fails, even if the caller ignores the HTTP error", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)?.content).toBe("required task");
          },
          response: { type: "text", text: "must not be returned" },
        },
      ],
    });
    servers.push(server);
    const response = await post(server);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("must not be returned");
    expect(() => server.assertComplete()).toThrow(/required task/);
  });

  it("rejects incomplete scenarios and unexpected extra model requests", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "fixture" } }],
    });
    servers.push(server);
    expect(() => server.assertComplete()).toThrow(/Not all model fixture steps/);
    expect((await post(server)).status).toBe(200);
    server.assertComplete();
    expect((await post(server)).status).toBe(400);
    expect(() => server.assertComplete()).toThrow(/Unexpected model request 2/);
  });

  it("rejects a request routed to the wrong model", async () => {
    const server = await startModelEmulator({ steps: [] });
    servers.push(server);
    expect((await post(server, { model: "wrong-model" })).status).toBe(400);
    expect(() => server.assertComplete()).toThrow(/Model routing changed/);
  });

  it("requires argument fragments to faithfully represent the scripted tool arguments", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "bad-fragments",
            name: "write_file",
            arguments: { path: "file" },
            argumentChunks: ["{}"],
          },
        },
      ],
    });
    servers.push(server);
    expect((await post(server)).status).toBe(400);
    expect(() => server.assertComplete()).toThrow();
  });
});
