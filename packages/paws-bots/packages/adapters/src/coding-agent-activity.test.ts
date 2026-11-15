import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeCodingAgent } from "./coding-agent-activity.js";

describe("activeCodingAgent", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "coding-agent-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function session(file: string, minutesAgo: number) {
    const target = path.join(home, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{}\n");
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await utimes(target, at, at);
  }

  it("names the agent whose session was written within the window", async () => {
    await session(".codex/sessions/2026/10/30/rollout-old.jsonl", 60);
    await session(".claude/projects/-home-user-work/session.jsonl", 2);

    await expect(activeCodingAgent(localShell(home), computer, context, 10 * 60_000)).resolves.toBe(
      "claude",
    );
  });

  it("finds no agent once every session has been quiet for the window", async () => {
    await session(".codex/sessions/2026/10/30/rollout.jsonl", 11);
    await session(".local/share/opencode/opencode.db", 30);

    await expect(
      activeCodingAgent(localShell(home), computer, context, 10 * 60_000),
    ).resolves.toBeUndefined();
  });

  it("finds no agent when the probe cannot run", async () => {
    const broken = {
      // biome-ignore lint/correctness/useYield: the provider fails before any output.
      async *execute() {
        throw new Error("sandbox unreachable");
      },
    } as unknown as SandboxProvider;

    await expect(activeCodingAgent(broken, computer, context, 60_000)).resolves.toBeUndefined();
  });
});

const computer = { id: "computer", kind: "boat" } as ComputerRef;
const context = { signal: new AbortController().signal } as AdapterContext;

function localShell(home: string): SandboxProvider {
  return {
    async *execute(_computer: ComputerRef, request: { argv: string[] }) {
      const [command = "", ...args] = request.argv;
      const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) =>
        execFile(
          command,
          args,
          { env: { ...process.env, HOME: home } },
          (error: ExecFileException | null, out: string) =>
            resolve({ stdout: out, code: typeof error?.code === "number" ? error.code : 0 }),
        ),
      );
      yield { type: "stdout" as const, data: stdout };
      yield { type: "exit" as const, code };
    },
  } as unknown as SandboxProvider;
}
