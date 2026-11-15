import assert from "node:assert/strict";
import type {
  AdapterContext,
  BrowserProvider,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
  builtinAgentTools,
  observationToolResult,
  PiAgentRuntime,
} from "@rakazo/adapters";
import { CONTACTS_CSV, CONTACTS_PATH, EXPORT_FIXTURE_URL } from "./computer-replay-fixture.js";
import type {
  ModelEmulatorRequest,
  ModelEmulatorResponse,
  ModelEmulatorStep,
} from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

export function computerReplayContext(): AdapterContext {
  return {
    operationId: "computer-replay",
    traceId: "computer-replay",
    spaceId: "fixture-space",
    userId: "fixture-user",
    botId: "fixture-bot",
    signal: AbortSignal.timeout(120_000),
  };
}

/** Real Pi and production tool helpers; excludes database executor, authorization, and UI. */
export async function runComputerReplay(
  sandbox: SandboxProvider,
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  const tool = (
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): ModelEmulatorResponse => ({ type: "tool", id, name, arguments: args });
  const step = (
    response: ModelEmulatorStep["response"],
    expectedId?: string,
    verify?: (result: Record<string, unknown>) => void,
  ): ModelEmulatorStep => ({
    expect(request) {
      if (!expectedId) return;
      const result = lastToolResult(request, expectedId);
      assert.ok(
        !result.error && !result.fallback,
        `Tool ${expectedId} failed: ${JSON.stringify(result)}`,
      );
      verify?.(result);
    },
    response,
  });
  const click = (id: string, expectedId: string, name: string) =>
    step((request) => {
      const result = lastToolResult(request, expectedId);
      const target = controlsInTree(result.tree).find((element) => element.name === name);
      assert.ok(target, `Current snapshot is missing ${name}`);
      return tool(id, "browser_act", { actions: [{ kind: "click", ref: target.ref }] });
    }, expectedId);
  const emulator = await startModelEmulator({
    steps: [
      step(tool("navigate", "browser_navigate", { url: EXPORT_FIXTURE_URL })),
      step(tool("snapshot-contacts", "browser_snapshot", {}), "navigate"),
      click("open-export", "snapshot-contacts", "Export contacts"),
      step(tool("snapshot-dialog", "browser_snapshot", {}), "open-export", (result) =>
        assert.equal(result.ok, true),
      ),
      click("download", "snapshot-dialog", "Download CSV"),
      step(tool("snapshot-complete", "browser_snapshot", {}), "download", (result) =>
        assert.equal(result.ok, true),
      ),
      step(tool("observe", "computer_observe", {}), "snapshot-complete", (result) =>
        assert.equal(result.title, "Export complete"),
      ),
      {
        expect(request) {
          const result = request.messages.findLast((message) => message.role === "tool");
          assert.equal(result?.tool_call_id, "observe");
          assert.match(String(result?.content), /computer observed/);
          // Shared OpenAI-compatible connections currently advertise text-only.
          // Protect the explicit fallback; do not pretend this tests image understanding.
          assert.match(
            String(result?.content),
            /tool image omitted: model does not support images/,
          );
        },
        response: tool("read-csv", "read_file", { path: CONTACTS_PATH }),
      },
      step({ type: "text", text: "Exported 2 contacts." }, "read-csv", (result) =>
        assert.equal(result.content, CONTACTS_CSV),
      ),
    ],
  });
  const usedTools: string[] = [];
  let text = "";
  try {
    const names = new Set([
      "browser_navigate",
      "browser_snapshot",
      "browser_act",
      "computer_observe",
      "read_file",
    ]);
    for await (const event of new PiAgentRuntime().run(
      {
        botId: context.botId!,
        threadId: "fixture-thread",
        runId: "fixture-run",
        prompt:
          "Export the contacts from the open contacts application as a CSV and check the saved file.",
        instructions:
          "Complete the requested task using your computer. Inspect current state before acting.",
        history: [],
        tools: builtinAgentTools.filter((definition) => names.has(definition.name)),
        // Exercise a normal vision-model window with real screenshot budgeting.
        model: { ...emulator.model, contextWindow: 128_000 },
        executeTool: async (name, args) => {
          usedTools.push(name);
          if (name === "browser_navigate")
            return browserNavigateFromTool(browser, computer, context, args);
          if (name === "browser_snapshot")
            return browserSnapshotFromTool(browser, computer, context, args);
          if (name === "browser_act") return browserActFromTool(browser, computer, context, args);
          if (name === "computer_observe") {
            const observation = await sandbox.observe(computer, context);
            assert.equal(observation.mimeType, "image/png");
            assert.deepEqual([...observation.image.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
            return observationToolResult(observation);
          }
          if (name === "read_file") {
            assert.equal(args.path, CONTACTS_PATH);
            // Chrome may finish the download after the click handler updates the page.
            return {
              path: args.path,
              content: await waitForReplayFile(sandbox, computer, context, CONTACTS_PATH),
            };
          }
          throw new Error(`Unexpected tool ${name}`);
        },
      },
      context,
    )) {
      if (event.type === "text") text += event.text;
    }
    emulator.assertComplete();
    assert.equal(text, "Exported 2 contacts.");
    return { usedTools, modelRequests: emulator.requests.length, text };
  } catch (error) {
    emulator.assertComplete();
    throw error;
  } finally {
    await emulator.close();
  }
}

/**
 * The controls a snapshot tree lists, as "- role "name" [..., ref=eN]" lines from a live computer or
 * "- role "name" [eN]" lines from the in-process page (the model's text carries no other copy).
 */
export function controlsInTree(tree: unknown): Array<{ name: string; ref: string }> {
  return String(tree ?? "")
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*- \S+ ("(?:[^"\\]|\\.)*") \[(?:(?:[^\]]*, )?ref=)?(e\d+)\]/.exec(line);
      return match ? [{ name: JSON.parse(match[1]!) as string, ref: match[2]! }] : [];
    });
}

function lastToolResult(
  request: ModelEmulatorRequest,
  expectedId: string,
): Record<string, unknown> {
  const result = request.messages.findLast((message) => message.role === "tool");
  assert.equal(
    result?.tool_call_id,
    expectedId,
    "Pi must continue with the corresponding tool result",
  );
  const content = result?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: { text?: string }) => part.text ?? "").join("")
        : "";
  return JSON.parse(text) as Record<string, unknown>;
}

export async function waitForReplayFile(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  file: string,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return new TextDecoder().decode(await sandbox.readFile(computer, file, context));
    } catch {
      context.signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Browser did not create ${file}`);
}
