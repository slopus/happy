import type { JobPublisher } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("history compaction with real Pi", () => {
  it.each(["", "   "])("preserves history and retries an empty summary (%j)", async (text) => {
    const summary = "Earlier decisions and the new conversation facts.";
    const server = await startModelEmulator({
      steps: [text, summary].map((response, index) => ({
        expect(request) {
          expect(JSON.stringify(request.messages)).toContain("Earlier decisions.");
          expect(JSON.stringify(request.messages)).toContain("New conversation facts.");
        },
        response: { type: "text", text: response },
        usage: {
          prompt_tokens: 100 + index,
          completion_tokens: 10,
          total_tokens: 110 + index,
          prompt_tokens_details: { cached_tokens: 20 },
        },
      })),
    });
    cleanups.push(() => server.close());
    const thread = {
      id: "fixture-thread",
      botId: "fixture-bot",
      spaceId: "fixture-space",
      userId: "fixture-user",
      nextMessageSeq: 51,
      historyCompactedUpToSeq: 49,
      historyCompactionGeneration: 0,
      historyCompactionSummary: "Earlier decisions.",
    };
    const updateMany = vi.fn(
      async (args: {
        data: { historyCompactedUpToSeq: number; historyCompactionSummary: string };
      }) => {
        Object.assign(thread, args.data);
        return { count: 1 };
      },
    );
    const createMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
    const create = vi.fn();
    const prisma = {
      thread: { findUniqueOrThrow: vi.fn(async () => thread), updateMany },
      spaceMember: {
        findUnique: vi.fn(async () => ({ userId: thread.userId })),
        count: vi.fn(async () => 1),
      },
      message: {
        findMany: vi.fn(async () => [
          {
            seq: 50,
            role: "user",
            blocks: [{ kind: "text", text: "New conversation facts." }],
          },
        ]),
      },
      usageRecord: { createMany, create },
      modelCreditEntry: { findUnique: async () => null },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    };
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const jobs = { enqueue: vi.fn(async () => undefined) };
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      runtime: new PiAgentRuntime(),
      jobs: jobs as unknown as JobPublisher,
      memoryProviders,
      resolveModel: async () => server.model,
    };

    await expect(compactHistory(deps, thread.id)).rejects.toThrow("summarizer returned no summary");
    expect(updateMany).not.toHaveBeenCalled();
    expect(thread.historyCompactedUpToSeq).toBe(49);
    expect(thread.historyCompactionSummary).toBe("Earlier decisions.");
    expect(memoryProviders.resolve).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany.mock.calls[0]?.[0]).toMatchObject({
      skipDuplicates: true,
      data: [
        {
          spaceId: thread.spaceId,
          userId: thread.userId,
          botId: thread.botId,
          operationKind: "compaction",
          inputTokens: 80,
          outputTokens: 10,
          cacheReadTokens: 20,
          totalTokens: 110,
          callId: expect.any(String),
        },
      ],
    });

    await compactHistory(deps, thread.id);
    server.assertComplete();
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: thread.id,
        historyCompactedUpToSeq: 49,
        historyCompactionGeneration: 0,
      },
      data: {
        historyCompactedUpToSeq: 50,
        historyCompactionSummary: summary,
        historyCompactionRetryAfterSeq: null,
      },
    });
    expect(memoryProviders.resolve).toHaveBeenCalledOnce();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[1]?.[0]).toMatchObject({
      skipDuplicates: true,
      data: [
        {
          operationKind: "compaction",
          inputTokens: 81,
          outputTokens: 10,
          cacheReadTokens: 20,
          totalTokens: 111,
          callId: expect.any(String),
        },
      ],
    });
    expect(create).not.toHaveBeenCalled();
  });
});
