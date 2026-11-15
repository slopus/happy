import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTOMATED_MESSAGE_LABEL,
  relabelToolImageMessages,
  TOOL_IMAGES_LABEL,
  TOOL_IMAGES_TEXT,
  withAutomatedLabels,
} from "./automated-messages.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";
import {
  SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT,
  SILENT_TOOL_CONTINUATION_PROMPT,
} from "./pi-runtime.js";
import { reliableModelStream } from "./pi-runtime-stream.js";
import { formatFinishedShellCommand } from "./shell-command-stream.js";

const image = { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } };

describe("automated messages are labelled as not from the user", () => {
  it("relabels the screenshot message pi-ai adds after a tool result and keeps the images", () => {
    const payload = {
      model: "m",
      messages: [
        { role: "user", content: "Open the site." },
        { role: "tool", tool_call_id: "c1", content: "(see attached image)" },
        { role: "user", content: [{ type: "text", text: TOOL_IMAGES_TEXT }, image] },
      ],
    };
    const next = relabelToolImageMessages(payload) as typeof payload;
    expect(next.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: TOOL_IMAGES_LABEL }, image],
    });
    expect(next.messages.slice(0, 2)).toEqual(payload.messages.slice(0, 2));
    expect(next.model).toBe("m");
  });

  it("leaves real user messages and other payloads alone", () => {
    expect(
      relabelToolImageMessages({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }, image] }],
      }),
    ).toBeUndefined();
    expect(
      relabelToolImageMessages({ messages: [{ role: "user", content: TOOL_IMAGES_TEXT }] }),
    ).toBeUndefined();
    expect(relabelToolImageMessages({ input: [] })).toBeUndefined();
    expect(relabelToolImageMessages(undefined)).toBeUndefined();
  });

  it("runs after an existing onPayload hook and works without one", async () => {
    const original = {
      messages: [{ role: "user", content: [{ type: "text", text: TOOL_IMAGES_TEXT }, image] }],
    };
    const replaced = { ...original, extra: true };
    type Options = { onPayload?: (payload: unknown, model: never) => unknown };
    const hooked = withAutomatedLabels<Options>({ onPayload: async () => replaced });
    const out = (await hooked.onPayload?.(original, undefined as never)) as typeof replaced;
    expect(out.extra).toBe(true);
    expect(out.messages[0]?.content[0]).toEqual({ type: "text", text: TOOL_IMAGES_LABEL });
    const plain = withAutomatedLabels<Options>(undefined);
    expect(await plain.onPayload?.({ messages: [] }, undefined as never)).toBeUndefined();
  });

  it("marks Rakazo's continue nudges and finished shell output, and lets the bot ask the user", () => {
    for (const prompt of [
      SILENT_TOOL_CONTINUATION_PROMPT,
      SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT,
    ]) {
      expect(prompt.startsWith(AUTOMATED_MESSAGE_LABEL)).toBe(true);
      expect(prompt).not.toContain("Do not stop after a tool call");
      expect(prompt).toContain("ask them instead of guessing");
    }
    expect(SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT).toContain(
      "stay silent when there is nothing to report",
    );
    const shell = formatFinishedShellCommand({ code: 0, stdout: "done", stderr: "" });
    expect(shell.startsWith(`${AUTOMATED_MESSAGE_LABEL} Shell command finished.`)).toBe(true);
    expect(shell).toContain("stdout:\ndone");
  });

  describe("end to end through the model library", () => {
    let server: Server;
    let baseUrl: string;
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    beforeEach(async () => {
      bodies.length = 0;
      server = createServer((req, res) => {
        // Local tools can probe any listening loopback port; only model calls are recorded.
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
          res.writeHead(404).end();
          return;
        }
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta: object, finish: string | null) =>
            `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          res.end(
            chunk({ role: "assistant", content: "OK" }, null) +
              chunk({}, "stop") +
              "data: [DONE]\n\n",
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    });
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("sends the screenshot after a tool result labelled as automated", async () => {
      const models = registerOpenAiCompatibleRuntime(builtinModels(), {
        modelId: "m",
        baseUrl,
        acceptsImages: true,
        allowPrivate: true,
      });
      const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "m")!;
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const context = {
        systemPrompt: "You are a test bot.",
        messages: [
          { role: "user", content: [{ type: "text", text: "Look at the screen." }], timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "computer_observe", arguments: {} }],
            api: model.api,
            provider: model.provider,
            model: "m",
            usage,
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "computer_observe",
            content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
            isError: false,
            timestamp: 3,
          },
        ],
      };
      const stream = reliableModelStream(
        models,
        model,
        context as never,
        withAutomatedLabels({ apiKey: "local" }) as never,
        undefined,
      );
      for await (const _event of stream) {
        // drain
      }
      const sent = bodies.at(-1)!;
      const users = sent.messages.filter((m) => m.role === "user");
      expect(JSON.stringify(users.at(-1)?.content)).toContain(TOOL_IMAGES_LABEL);
      expect(JSON.stringify(sent)).not.toContain(TOOL_IMAGES_TEXT);
      expect(JSON.stringify(users.at(-1)?.content)).toContain("data:image/png;base64,aGk=");
    });
  });
});
