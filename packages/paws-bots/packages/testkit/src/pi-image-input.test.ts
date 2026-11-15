import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

const image = {
  name: "picture.png",
  mimeType: "image/png" as const,
  data: new Uint8Array([137, 80, 78, 71]),
};

function request(model: AgentRunRequest["model"]): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Read this picture",
    instructions: "Complete the requested task.",
    history: [],
    tools: [],
    model,
  };
}

async function exhaust(events: AsyncIterable<AgentRuntimeEvent>) {
  for await (const _event of events) {
    // Exercise real Pi through its terminal state.
  }
}

describe("real Pi current-image compatibility", () => {
  it("rejects persisted current-run visual intent without fabricated current bytes", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "Must not be called" } }],
    });
    cleanups.push(() => server.close());
    const beforeCall = vi.fn(async () => "fixture-reservation");
    const input = { ...request(server.model), currentRunRequiresImageInput: true };
    expect(input).not.toHaveProperty("currentTurnImages");
    await expect(
      exhaust(
        new PiAgentRuntime({
          modelCallObserver: { beforeCall, afterCall: vi.fn(async () => undefined) },
        }).run(input),
      ),
    ).rejects.toThrow();
    expect(beforeCall).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });
  it("rejects current images before usage reservation or silent Pi downgrade", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "Fixture response" } }],
    });
    cleanups.push(() => server.close());
    const beforeCall = vi.fn(async () => "fixture-reservation");
    const runtime = new PiAgentRuntime({
      modelCallObserver: { beforeCall, afterCall: vi.fn(async () => undefined) },
    });
    const input = { ...request(server.model), currentTurnImages: [image] };

    await expect(exhaust(runtime.run(input))).rejects.toThrow();
    expect(beforeCall).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });

  it("keeps verified legacy image-as-file execution available to text-only models", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "Fixture response" } }],
    });
    cleanups.push(() => server.close());
    const input = {
      ...request(server.model),
      currentTurnImages: [image],
      currentTurnImageFileFallback: true,
    };
    await expect(exhaust(new PiAgentRuntime().run(input))).resolves.toBeUndefined();
    server.assertComplete();
  });
  it("rejects initial steering images before usage reservation", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "Fixture response" } }],
    });
    cleanups.push(() => server.close());
    const beforeCall = vi.fn(async () => "fixture-reservation");
    const input = request(server.model);
    input.claimSteering = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "steering-1", messageId: "message-1", text: "Read this", images: [image] },
      ])
      .mockResolvedValue([]);
    await expect(
      exhaust(
        new PiAgentRuntime({
          modelCallObserver: { beforeCall, afterCall: vi.fn(async () => undefined) },
        }).run(input),
      ),
    ).rejects.toThrow();
    expect(beforeCall).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });

  it("rejects live steering images before the next model reservation", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "tool", id: "fixture-tool", name: "fixture_tool", arguments: {} },
        },
      ],
    });
    cleanups.push(() => server.close());
    const beforeCall = vi.fn(async () => "fixture-reservation");
    const input = request(server.model);
    input.tools = [
      {
        name: "fixture_tool",
        description: "Return a deterministic result",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    input.executeTool = vi.fn(async () => ({ ok: true }));
    input.claimSteering = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "live-image", messageId: "live-message", text: "Read this", images: [image] },
      ])
      .mockResolvedValue([]);
    await expect(
      exhaust(
        new PiAgentRuntime({
          modelCallObserver: { beforeCall, afterCall: vi.fn(async () => undefined) },
        }).run(input),
      ),
    ).rejects.toThrow();
    expect(beforeCall).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(1);
    server.assertComplete();
  });

  it("can use an accepted image in history after changing to a vision model", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect(input) {
            expect(JSON.stringify(input.messages)).toContain("image_url");
          },
          response: { type: "text", text: "Fixture response" },
        },
      ],
    });
    cleanups.push(() => server.close());
    const input = request({ ...server.model, acceptsImages: true });
    input.prompt = "Read the earlier picture";
    input.history = [{ role: "user", content: "Earlier picture", images: [image] }];
    await expect(exhaust(new PiAgentRuntime().run(input))).resolves.toBeUndefined();
    server.assertComplete();
  });

  it("retains images on the wire for a vision-capable effective model", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect(input) {
            expect(JSON.stringify(input.messages)).toContain("image_url");
          },
          response: { type: "text", text: "Fixture response" },
        },
      ],
    });
    cleanups.push(() => server.close());
    const input = {
      ...request({ ...server.model, acceptsImages: true }),
      currentTurnImages: [image],
    };
    await expect(exhaust(new PiAgentRuntime().run(input))).resolves.toBeUndefined();
    server.assertComplete();
  });

  it("does not reject a text-only follow-up merely because old history has an image", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "Fixture response" } }],
    });
    cleanups.push(() => server.close());
    const input = request(server.model);
    input.prompt = "Continue with the text";
    input.history = [{ role: "user", content: "Earlier picture", images: [image] }];
    await expect(exhaust(new PiAgentRuntime().run(input))).resolves.toBeUndefined();
    server.assertComplete();
  });
});
