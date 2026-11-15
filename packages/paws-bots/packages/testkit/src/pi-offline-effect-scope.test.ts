import { PiAgentRuntime } from "@rakazo/adapters";
import { expect, it, vi } from "vitest";
import { builtinAgentTools } from "../../adapters/src/builtin-tools.js";
import { recordEffect, runScopedToolExecutionId } from "../../adapters/src/run-effects.js";
import { startModelEmulator } from "./model-emulator.js";

it("isolates main and sibling effects with identical wire IDs and reconciles a child retry", async () => {
  const write = (content: string) => ({
    expect() {},
    response: {
      type: "tool" as const,
      id: "call_1",
      name: "write_file",
      arguments: { path: "fixture.txt", content },
    },
  });
  const delegate = (id: string) => ({
    expect() {},
    response: {
      type: "tool" as const,
      id,
      name: "run_subagent",
      arguments: { name: id, task: "Write the synthetic fixture." },
    },
  });
  const done = {
    expect() {},
    response: { type: "text" as const, text: "Done." },
  };
  const model = await startModelEmulator({
    steps: [
      write("main"),
      delegate("child-a"),
      write("child-a"),
      write("child-a"),
      done,
      delegate("child-b"),
      write("child-b"),
      done,
      done,
    ],
  });
  const run = {
    id: "fixture-run",
    spaceId: "fixture-space",
    botId: "fixture-bot",
    threadId: "fixture-thread",
  };
  const effects = new Map<
    string,
    {
      id: string;
      runId: string;
      spaceId: string;
      status: string;
      result?: unknown;
    }
  >();
  const deps = {
    prisma: {
      externalEffect: {
        findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
          effects.get(where.idempotencyKey) ?? null,
        findMany: async () => [],
        create: async ({
          data,
        }: {
          data: {
            runId: string;
            spaceId: string;
            idempotencyKey: string;
            status: string;
          };
        }) => {
          const effect = { ...data, id: `effect-${effects.size}` };
          effects.set(data.idempotencyKey, effect);
          return effect;
        },
      },
    },
    events: { append: vi.fn() },
  } as unknown as Parameters<typeof recordEffect>[0];
  const writes: string[] = [];
  const ids: string[] = [];
  const runtime = new PiAgentRuntime();
  try {
    for await (const _event of runtime.run({
      botId: run.botId,
      threadId: run.threadId,
      runId: run.id,
      instructions: "Complete synthetic fixture.",
      prompt: "Write then ask both helpers to write.",
      history: [],
      tools: builtinAgentTools.filter(
        (tool) => tool.name === "write_file" || tool.name === "run_subagent",
      ),
      model: { ...model.model, maxTokens: 256 },
      executeTool: async (name, args, executionId) => {
        expect(name).toBe("write_file");
        ids.push(executionId);
        const applied = await recordEffect(
          deps,
          run,
          name,
          runScopedToolExecutionId(run.id, executionId),
          args,
        );
        if (applied.duplicate) return applied.effect.result;
        writes.push(String(args.content));
        applied.effect.status = "completed";
        applied.effect.result = { written: String(args.content) };
        return applied.effect.result;
      },
    })) {
    }
    model.assertComplete();
    expect(writes).toEqual(["main", "child-a", "child-b"]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(ids[2]);
    expect(ids.map((id) => JSON.parse(id)[2])).toEqual(["call_1", "call_1", "call_1", "call_1"]);
    expect(
      model.requests
        .flatMap((request) => request.messages.filter((message) => message.role === "tool"))
        .some((message) => message.tool_call_id === "call_1"),
    ).toBe(true);
  } finally {
    await runtime.abort(run.id);
    await model.close();
  }
}, 30000);
