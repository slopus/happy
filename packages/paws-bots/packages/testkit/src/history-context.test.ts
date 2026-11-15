import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { estimateTextTokens } from "../../adapters/src/context-selection.js";
import { startModelEmulator } from "./model-emulator.js";

describe("structured results through real Pi context selection", () => {
  it("preserves valid history JSON and follows a shortened original-text cursor", async () => {
    const original = `Verified original fact: ORBIT-731.\n${'"\n'.repeat(2000)}`;
    let cursor = 0;
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "history-first",
            name: "read_history",
            arguments: { messageId: "original", textOffset: 0, limit: 1 },
          },
        },
        {
          expect(request) {
            const result = JSON.parse(
              String(request.messages.findLast((message) => message.role === "tool")?.content),
            );
            expect(result.messages[0].text).toContain("ORBIT-731");
            expect(result.messages[0].truncated).toBe(true);
            cursor = result.messages[0].nextTextOffset;
            expect(cursor).toBeGreaterThan(0);
            expect(cursor).toBeLessThan(2000);
            expect(result.messages[0].text).toBe(original.slice(0, cursor));
          },
          response: () => ({
            type: "tool",
            id: "history-next",
            name: "read_history",
            arguments: { messageId: "original", textOffset: cursor, limit: 1 },
          }),
        },
        {
          expect(request) {
            const result = JSON.parse(
              String(request.messages.findLast((message) => message.role === "tool")?.content),
            );
            expect(result.messages[0].textOffset).toBe(cursor);
            expect(result.messages[0].text).toBe(original.slice(cursor, cursor + 120));
          },
          response: { type: "text", text: "Original fact verified: ORBIT-731." },
        },
      ],
    });
    try {
      const request: AgentRunRequest = {
        botId: "synthetic-bot",
        threadId: "synthetic-thread",
        runId: "synthetic-run",
        prompt: "Inspect the original fact and follow its text cursor.",
        instructions: "Treat history as evidence.",
        history: [],
        contextStrategy: "retrieval",
        model: { ...server.model, contextWindow: 3072, maxTokens: 512 },
        tools: [
          {
            name: "read_history",
            description: "Read a bounded original message page.",
            inputSchema: {
              type: "object",
              properties: {
                messageId: { type: "string" },
                textOffset: { type: "integer" },
                limit: { type: "integer" },
              },
              required: ["messageId"],
            },
          },
        ],
        executeTool: async (_name, args) => {
          const offset = (args as { textOffset: number }).textOffset;
          const length = calls++ === 0 ? 2000 : 120;
          return {
            untrusted: true,
            messages: [
              {
                messageId: "original",
                text: original.slice(offset, offset + length),
                textOffset: offset,
                nextTextOffset: offset + length,
                truncated: true,
              },
            ],
            runs: [],
            snapshots: [],
            nextRunId: null,
            nextArtifactId: null,
            nextOutcomeSeq: null,
          };
        },
      };
      let finalText: string | undefined = "";
      for await (const event of new PiAgentRuntime().run(request))
        if (event.type === "done") finalText = event.text;
      server.assertComplete();
      expect(calls).toBe(2);
      expect(finalText).toContain("ORBIT-731");
    } finally {
      await server.close();
    }
  });
  it.each(["retrieval", "snapshots", "cache-aware"] as const)(
    "follows twelve oversized JSON diagnostic segments within a small %s context",
    async (contextStrategy) => {
      let calls = 0;
      const decisions: Array<{ droppedMessages: number; truncatedToolResults: number }> = [];
      const server = await startModelEmulator({
        steps: Array.from({ length: 13 }, (_, index) => ({
          expect(request) {
            const serialized = JSON.stringify(request.messages);
            expect(estimateTextTokens(serialized)).toBeLessThan(3584);
            expect(serialized).toContain("Approval remains pending");
            expect(serialized).not.toContain("obsolete-old-0");
            if (index > 0) {
              const tool = request.messages.findLast((message) => message.role === "tool");
              const result = JSON.parse(String(tool?.content));
              expect(result.segment).toBe(index - 1);
              expect(result.nextCursor).toBe(index === 12 ? null : `segment-${index}`);
              expect(result.approval).toBe("pending");
              expect(result.diagnostic).toContain("Tool result truncated");
            }
          },
          response:
            index === 12
              ? { type: "text" as const, text: "All twelve segments verified; approval pending." }
              : {
                  type: "tool" as const,
                  id: `diagnostic-${index}`,
                  name: "CRM_READ_DIAGNOSTIC",
                  arguments: { cursor: index === 0 ? "start" : `segment-${index}` },
                },
        })),
      });
      try {
        const request: AgentRunRequest = {
          botId: "synthetic-bot",
          threadId: "synthetic-thread",
          runId: "synthetic-run",
          prompt: "Approval remains pending. Follow all diagnostic cursors. Do not deploy.",
          instructions:
            "Use read-only diagnostic evidence and preserve the current approval state.",
          history: Array.from({ length: 100 }, (_, index) => ({
            id: `old-${index}`,
            role: "user" as const,
            content: `obsolete-old-${index}: ${"irrelevant history ".repeat(50)}`,
          })),
          contextStrategy,
          model: { ...server.model, contextWindow: 4096, maxTokens: 512 },
          tools: [
            {
              name: "CRM_READ_DIAGNOSTIC",
              description: "Read one dependent diagnostic segment.",
              inputSchema: {
                type: "object",
                properties: { cursor: { type: "string" } },
                required: ["cursor"],
              },
            },
          ],
          executeTool: async (name, args) => {
            expect(name).toBe("CRM_READ_DIAGNOSTIC");
            expect(args).toMatchObject({ cursor: calls === 0 ? "start" : `segment-${calls}` });
            const segment = calls++;
            return {
              segment,
              nextCursor: segment === 11 ? null : `segment-${segment + 1}`,
              approval: "pending",
              diagnostic: 'Quoted "diagnostic" evidence.\n'.repeat(1000),
            };
          },
        };
        let finalText: string | undefined = "";
        for await (const event of new PiAgentRuntime({
          onContextDecision: (decision) => decisions.push(decision),
        }).run(request)) {
          if (event.type === "done") finalText = event.text;
        }
        server.assertComplete();
        expect(calls).toBe(12);
        expect(finalText).toContain("approval pending");
        expect(decisions.some((decision) => decision.truncatedToolResults > 0)).toBe(true);
        expect(decisions.at(-1)!.droppedMessages).toBeGreaterThan(decisions[0]!.droppedMessages);
      } finally {
        await server.close();
      }
    },
  );
});
