import { once } from "node:events";
import { createServer } from "node:http";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolExecutionObserver,
} from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

it("marks the reply to a finished shell as a new assistant message", async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    // Local tools can probe any listening loopback port; only model calls are counted.
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const body =
      calls === 1
        ? chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "shell-1",
                  type: "function",
                  function: { name: "shell", arguments: '{"command":"long-job"}' },
                },
              ],
            },
            "tool_calls",
          )
        : calls === 2
          ? chunk({ role: "assistant", content: "Started" }) +
            chunk({ content: " the job." }, "stop")
          : chunk({ role: "assistant", content: "It finished." }, "stop");
    response.end(`${body}data: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  const executeTool = async (
    _name: string,
    _args: Record<string, unknown>,
    _executionId: string,
    _route: unknown,
    observer?: AgentToolExecutionObserver,
  ) => {
    observer?.onShellStillRunning?.(Promise.resolve({ stdout: "ok", stderr: "", code: 0 }));
    return { stdout: "", stderr: "", code: null, running: true };
  };
  const events: AgentRuntimeEvent[] = [];
  try {
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: "fixture-run",
        prompt: "Start the long job.",
        instructions: "Fixture",
        history: [],
        tools: [
          {
            name: "shell",
            description: "Run a command",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
        executeTool,
        model: {
          provider: "openai-compatible",
          id: "fixture",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowPrivateEndpoint: true,
        },
      },
      { signal: AbortSignal.timeout(15_000) },
    )) {
      events.push(event);
    }
    expect(calls).toBe(3);
    expect(
      events.flatMap((event) =>
        event.type === "text" ? [event.text] : event.type === "turn" ? ["<turn>"] : [],
      ),
    ).toEqual(["Started", " the job.", "<turn>", "It finished."]);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});

const shellCall = (id: string) =>
  chunk(
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name: "shell", arguments: JSON.stringify({ command: id }) },
        },
      ],
    },
    "tool_calls",
  );

type FinishedShell = { stdout: string; stderr: string; code: number };

/** A model endpoint that answers request `n` with `script(n)`, and records what it was sent. */
async function modelFixture(script: (n: number) => string) {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    // Local tools can probe any listening loopback port; only model calls are recorded.
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const part of request) raw += String(part);
    requests.push(raw);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`${script(requests.length)}data: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  return {
    requests,
    port: address.port,
    close: async () => {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}

/** Runs a bot whose `shell` tool backgrounds the commands in `background`. */
async function runWithShells(
  port: number,
  background: Map<string, Promise<FinishedShell>>,
  claimSteering?: AgentRunRequest["claimSteering"],
) {
  const executeTool = async (
    _name: string,
    args: Record<string, unknown>,
    _executionId: string,
    _route: unknown,
    observer?: AgentToolExecutionObserver,
  ) => {
    const completion = background.get(String(args.command));
    if (!completion) return { stdout: "done", stderr: "", code: 0 };
    observer?.onShellStillRunning?.(completion);
    return { stdout: "", stderr: "", code: null, running: true };
  };
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(
    {
      botId: "fixture-bot",
      threadId: "fixture-thread",
      runId: "fixture-run",
      prompt: "Build it.",
      instructions: "Fixture",
      history: [],
      tools: [
        {
          name: "shell",
          description: "Run a command",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      executeTool,
      claimSteering,
      model: {
        provider: "openai-compatible",
        id: "fixture",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        allowPrivateEndpoint: true,
      },
    },
    { signal: AbortSignal.timeout(15_000) },
  )) {
    events.push(event);
  }
  return events.flatMap((event) => (event.type === "text" ? [event.text] : []));
}

it("gives a finished command's output to the next model request, not to a turn after the reply", async () => {
  const fixture = await modelFixture((n) =>
    n === 1
      ? shellCall("background-one")
      : n === 2
        ? shellCall("quick-one")
        : n === 3
          ? shellCall("background-two")
          : n === 4
            ? shellCall("quick-two")
            : chunk({ role: "assistant", content: "All done." }, "stop"),
  );
  try {
    const texts = await runWithShells(
      fixture.port,
      new Map([
        ["background-one", Promise.resolve({ stdout: "one finished", stderr: "", code: 0 })],
        ["background-two", Promise.resolve({ stdout: "two finished", stderr: "", code: 0 })],
      ]),
    );
    expect(fixture.requests).toHaveLength(5);
    expect(fixture.requests[2]).toContain("one finished");
    expect(fixture.requests[4]).toContain("two finished");
    expect(texts).toEqual(["All done."]);
  } finally {
    await fixture.close();
  }
});

it("keeps the person's message moving while a command runs, and waits for it only at the end", async () => {
  const fixture = await modelFixture((n) =>
    n === 1
      ? shellCall("background")
      : n === 2
        ? shellCall("quick")
        : n === 3
          ? chunk({ role: "assistant", content: "Working on it." }, "stop")
          : chunk({ role: "assistant", content: "It finished." }, "stop"),
  );
  let exited = false;
  const background = new Promise<FinishedShell>((resolve) =>
    setTimeout(() => {
      exited = true;
      resolve({ stdout: "late output", stderr: "", code: 0 });
    }, 1_000),
  );
  let claims = 0;
  const steeringSeen: boolean[] = [];
  try {
    const texts = await runWithShells(
      fixture.port,
      new Map([["background", background]]),
      async () => {
        claims += 1;
        steeringSeen.push(exited);
        return claims === 3
          ? [{ id: "claim-1", messageId: "message-1", text: "Any news?", origin: "user" }]
          : [];
      },
    );
    // The message was claimed, and answered, before the command exited.
    expect(steeringSeen[2]).toBe(false);
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.requests[2]).toContain("Any news?");
    expect(fixture.requests[2]).not.toContain("late output");
    expect(fixture.requests[3]).toContain("late output");
    expect(texts).toEqual(["Working on it.", "It finished."]);
  } finally {
    await fixture.close();
  }
});

it("sends a finished command's output and a person's message in the same request", async () => {
  const fixture = await modelFixture((n) =>
    n === 1
      ? shellCall("background")
      : n === 2
        ? shellCall("quick")
        : chunk({ role: "assistant", content: "Done." }, "stop"),
  );
  let claims = 0;
  try {
    const texts = await runWithShells(
      fixture.port,
      new Map([["background", Promise.resolve({ stdout: "finished", stderr: "", code: 0 })]]),
      async () => {
        claims += 1;
        return claims === 3
          ? [{ id: "claim-1", messageId: "message-1", text: "Any news?", origin: "user" }]
          : [];
      },
    );
    expect(fixture.requests).toHaveLength(3);
    const shared = fixture.requests[2] ?? "";
    expect(shared).toContain("finished");
    expect(shared).toContain("Any news?");
    // The person's message is returned from the hook and the output steered, so the
    // message comes first in the request.
    expect(shared.indexOf("Any news?")).toBeLessThan(shared.indexOf("finished"));
    expect(texts).toEqual(["Done."]);
  } finally {
    await fixture.close();
  }
});
