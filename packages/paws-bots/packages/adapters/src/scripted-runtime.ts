import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import {
  APPROVED_ACTION_NOT_RUN_ERROR,
  abortableDelay,
  BOT_MESSAGE_WAKE_CUE,
  inferHandoffTargetName,
  MODEL_CONTEXT_TOO_SMALL_ERROR,
  MODEL_OUTPUT_CUT_ERROR,
  MODEL_REQUEST_LIMIT_ERROR,
  modelFallbackFailure,
  STEERING_CONTINUATION_PROMPT,
} from "@rakazo/core";

import { BACKGROUND_HELPER_TASK_CUE } from "./background-helpers.js";

const running = new Map<string, AbortController>();

export class ScriptedAgentRuntime implements AgentRuntime {
  describe() {
    return {
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: true },
    };
  }

  async abort(runId: string): Promise<void> {
    running.get(runId)?.abort();
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const controller = new AbortController();
    running.set(request.runId, controller);
    const signal = context?.signal ?? controller.signal;
    try {
      const relaysOutcome = helperOutcome(request.prompt) !== undefined;
      if (!relaysOutcome && shouldFail(request.prompt)) {
        throw new Error(scriptedFailure(request.prompt));
      }
      // Like Pi, a run first takes the messages waiting for it. A continuation exists only to
      // answer them, so their text is its prompt; any other run keeps its own task. A resumed
      // attempt claims the same rows again, so it rebuilds the script it was running.
      const steering = (await request.claimSteering?.([])) ?? [];
      const steeredPrompt =
        request.prompt.includes(STEERING_CONTINUATION_PROMPT) && steering.length
          ? steering.map((item) => item.historyText ?? item.text).join("\n")
          : undefined;
      const prompt = steeredPrompt ?? request.prompt;
      // A run hangs on its own words: a peer's wake on the peer's text, a reply without the
      // message it quotes.
      const hangMs = relaysOutcome
        ? undefined
        : hangDuration(peerMessage(prompt)?.text ?? prompt.replace(REPLY_CONTEXT, ""));
      if (hangMs !== undefined) {
        // Long-running work happens on the computer, which starts it like any real run would;
        // a background helper has none and works with what it was given.
        if (!prompt.startsWith(BACKGROUND_HELPER_TASK_CUE)) {
          yield {
            type: "tool",
            name: "list_files",
            args: { path: "" },
            executionId: `${request.runId}:list_files:hang`,
          };
        }
        yield { type: "progress", text: "still working…", activity: true };
        const hangUntil = Date.now() + hangMs;
        while (!controller.signal.aborted && !signal.aborted && Date.now() < hangUntil) {
          await abortableDelay(50, controller.signal);
          if (controller.signal.aborted || signal.aborted) break;
          yield { type: "progress", text: "still working…", activity: true };
        }
        yield { type: "done", text: Number.isFinite(hangMs) ? "done." : "stopped" };
        return;
      }
      const script =
        steeredPrompt !== undefined
          ? inferScript(steeredPrompt, request.resumeFromCheckpoint)
          : (request.script ?? inferScript(request.prompt, request.resumeFromCheckpoint));
      // Per-run call index so repeated tools (e.g. message_agent) get distinct
      // executionIds — delivery keys and effect replays key off this value.
      let toolCallSeq = 0;
      for (const turn of script) {
        if (signal.aborted || controller.signal.aborted) {
          yield { type: "done", text: "stopped" };
          return;
        }
        if (turn.assistant) {
          yield { type: "progress", text: "working…", activity: true };
          yield { type: "text", text: turn.assistant };
        }
        for (const call of turn.toolCalls ?? []) {
          const executionId = `${request.runId}:${call.name}:${toolCallSeq++}`;
          if (call.name === "run_subagent" && call.args.background !== true) {
            const agentId = `${request.runId}:subagent`;
            const name = String(call.args.name ?? "helper");
            const task = String(call.args.task ?? request.prompt);
            yield {
              type: "subagent",
              agentId,
              name,
              task,
              status: "running",
              progress: "working…",
            };
            yield {
              type: "tool",
              name: call.name,
              args: call.args,
              executionId,
            };
            yield {
              type: "subagent",
              agentId,
              name,
              task,
              status: "completed",
              result: `done. i handled: ${task.slice(0, 180)}`,
            };
            continue;
          }
          yield {
            type: "tool",
            name: call.name,
            args: call.args,
            executionId,
          };
        }
        if (turn.ask) {
          yield {
            type: "ask",
            text: turn.ask.text,
            detail: turn.ask.detail,
            actions: turn.ask.actions,
          };
          return;
        }
        if (turn.takeover) {
          yield { type: "takeover", reason: turn.takeover.reason };
          return;
        }
        if (turn.complete) {
          yield {
            type: "usage",
            inputTokens: 12,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            provider: "scripted",
            model: "scripted",
          };
          yield { type: "done", text: turn.assistant };
          return;
        }
      }
      yield { type: "text", text: "done." };
      yield { type: "done", text: "done." };
    } finally {
      controller.abort();
      running.delete(request.runId);
    }
  }
}

/** A JSON object written in a message, or undefined for anything else, malformed text included. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function inferScript(
  prompt: string,
  resumeFromCheckpoint?: string,
): NonNullable<AgentRunRequest["script"]> {
  // A helper's brief and the result it sends back are generated prompts that quote other words,
  // so they are recognized before any phrase inside them can pick another action.
  if (prompt.toLowerCase().startsWith(BACKGROUND_HELPER_TASK_CUE.toLowerCase())) {
    const task = prompt.split("Task from the bot (not from the user):\n").at(-1) ?? prompt;
    const url = /\bfetch (https?:\/\/\S+)/i.exec(task)?.[1];
    const write = /\bcrm\b/i.test(task);
    return [
      ...(url ? [{ toolCalls: [{ name: "web_fetch", args: { url } }] }] : []),
      ...(write
        ? [
            {
              toolCalls: [
                {
                  name: "destination.write",
                  args: { collection: "notes", title: "Helper note", body: task },
                },
              ],
            },
          ]
        : []),
      { assistant: `helper result: ${summarize(task)}`, complete: true },
    ];
  }
  const outcome = helperOutcome(prompt);
  if (outcome) {
    return [
      {
        assistant:
          outcome.status === "failed"
            ? `your helper could not finish: ${outcome.text}`
            : `your helper finished: ${outcome.text}`,
        complete: true,
      },
    ];
  }
  // A bot-message wake embeds the sender's name and id around the peer's words, and an
  // ordinary reply opens with the quoted target; a generated id can contain a journey
  // keyword by chance ("crm" inside a cuid), so the branches key on the words alone.
  const words = peerMessage(prompt)?.text ?? prompt.replace(REPLY_CONTEXT, "");
  const lower = words.toLowerCase();
  // In a group the words open with the mention that picked this bot.
  const page = /^(?:@\S+\s+)?call save_page with (.+?)(?:\nthen say ([\s\S]+))?$/s.exec(
    words.trim(),
  );
  const pageArgs = page ? jsonObject(page[1]!) : undefined;
  if (page && pageArgs) {
    return [
      {
        assistant: page[2],
        toolCalls: [{ name: "save_page", args: pageArgs }],
        complete: true,
      },
    ];
  }
  if (lower.includes("can you check my gmail inbox?")) {
    return [
      {
        assistant: "Connect Gmail and I’ll check your inbox.",
        toolCalls: [{ name: "connect_app", args: { app: "gmail" } }],
        complete: true,
      },
    ];
  }
  if (lower.includes("silent routine fixture")) {
    return [
      {
        assistant: "Checking for changes.",
        toolCalls: [{ name: "list_files", args: { path: "" } }],
      },
      { assistant: "NO_RESPONSE", complete: true },
    ];
  }
  if (resumeFromCheckpoint === "takeover-skipped") {
    return [
      {
        assistant: "login was skipped. continuing without treating sign-in as done.",
        complete: true,
      },
    ];
  }
  if (resumeFromCheckpoint === "takeover") {
    return [
      {
        assistant:
          "signed in. the session stays in this computer — protected input never hit the thread.",
        complete: true,
      },
    ];
  }
  // A delegated result wakes the bot to relay it to the user. Before every content-based intent
  // so the peer's text cannot steal the branch.
  const report = delegatedReport(prompt);
  if (report) {
    return [{ assistant: `Here's what ${report.from} found: ${report.gist}`, complete: true }];
  }
  // Before every content-based intent so payload text cannot steal the branch.
  const shellCommand = /run the shell command\s+([\s\S]+)$/i.exec(prompt)?.[1]?.trim();
  if (shellCommand) {
    return [
      {
        assistant: "running it on my computer.",
        toolCalls: [{ name: "shell", args: { command: shellCommand } }],
        complete: true,
      },
    ];
  }
  if (lower.includes("run hostname on my computer")) {
    return [
      {
        assistant: "checking your computer's name.",
        toolCalls: [{ name: "user_computer_shell", args: { command: "hostname" } }],
        complete: true,
      },
    ];
  }
  const lookAt = /look at (.+?) on my computer/i.exec(prompt)?.[1]?.trim();
  if (lookAt) {
    return [
      {
        assistant: `looking at ${lookAt}.`,
        toolCalls: [{ name: "user_computer_observe", args: { app: lookAt } }],
        complete: true,
      },
    ];
  }
  const typeIn = /type "([^"]+)" in a new (.+?) document on my computer/i.exec(prompt);
  if (typeIn) {
    return [
      {
        assistant: `typing in ${typeIn[2]}.`,
        toolCalls: [
          {
            name: "user_computer_act",
            args: {
              app: typeIn[2],
              actions: [
                { kind: "menu", path: ["File", "New"] },
                { kind: "type", text: typeIn[1] },
              ],
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("message the bot named") || lower.includes("message bot named")) {
    const name = namedBot(prompt) ?? "Peer";
    const message =
      /named\s+[A-Za-z0-9][A-Za-z0-9_-]{0,39}\s+(?:saying|with|:)\s*([\s\S]+)$/i
        .exec(prompt)?.[1]
        ?.trim() ?? `Please help with: ${prompt}`;
    return [
      {
        assistant: "messaging that bot now.",
        toolCalls: [
          {
            name: "message_bot",
            args: {
              confirm_name: name,
              message,
              intent: "request",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  const childEdit = childEditCalls(prompt);
  if (childEdit) {
    return [{ assistant: "updating your bots.", toolCalls: childEdit, complete: true }];
  }
  const fleet = fleetCall(prompt);
  if (fleet) {
    return [{ assistant: "updating your bots.", toolCalls: [fleet], complete: true }];
  }
  if (
    lower.includes("launch a cloud agent") ||
    lower.includes("start a cloud agent") ||
    lower.includes("cloud coding agent")
  ) {
    return [
      {
        assistant: "launching a cloud agent for that.",
        toolCalls: [
          {
            name: "cloud_agent_launch",
            args: {
              prompt: "Add a README with setup instructions",
              repository: "https://github.com/example/demo",
              openPr: true,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("show a login card")) {
    return [
      {
        assistant: "i need that sign-in in a protected card.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "Example sign-in",
              purpose: "password",
              credential: {
                name: "example_login",
                origin: "https://login.example.test",
                auth: { type: "login" },
              },
            },
          },
        ],
      },
    ];
  }
  if (lower.includes("command variable secret card")) {
    return [
      {
        assistant: "i need that key in a protected field.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "Deploy key",
              purpose: "api_key",
              credential: { name: "deploy-key", auth: { type: "command" } },
            },
          },
        ],
      },
    ];
  }
  if (
    lower.includes("masked secret card") ||
    lower.includes("show a secret card") ||
    lower.includes("request a masked api key")
  ) {
    return [
      {
        assistant: "i need that value in a protected field.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "API key",
              purpose: "api_key",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          },
        ],
      },
    ];
  }
  if (lower.includes("fetch approval card")) {
    return [
      {
        assistant: "i will read that page.",
        toolCalls: [
          { name: "web_fetch", args: { url: "https://docs.example.test/page?q=fixture" } },
        ],
      },
    ];
  }
  // A wallet purchase: the wallet owner approves it in the wallet, so no card asks here.
  if (lower.includes("buy from the fixture shop")) {
    return [
      {
        assistant: "i will ask your wallet for that purchase.",
        toolCalls: [
          {
            name: "request_purchase",
            args: {
              merchantName: "Fixture Shop",
              merchantUrl: "https://shop.example.test/checkout",
              amount: 2_340,
              currency: "usd",
              reason:
                "The owner asked to buy the groceries already in the cart at this shop, and the checkout page shows this total.",
            },
          },
        ],
      },
    ];
  }
  // The site is not in the message, so the owner did not name it and the call asks.
  const paidRequest = /paid request card(?: on (\w+))?/.exec(lower);
  if (paidRequest) {
    const url = `https://api.${paidRequest[1] ?? "example"}.test/quote`;
    return [
      {
        assistant: "i will call that paid api.",
        toolCalls: [
          {
            name: "paid_request",
            args: {
              url,
              method: "GET",
              reason:
                "The owner asked for a live price quote from this paid API, which answers only after a small per-request payment.",
            },
          },
        ],
      },
    ];
  }
  if (lower.includes("mcp approval card")) {
    return [
      {
        assistant: "i will register that server for your approval.",
        toolCalls: [
          {
            name: "add_mcp_server",
            args: {
              name: "Fixture MCP",
              transport: "stdio",
              command: "echo",
              assignToSelf: true,
            },
          },
        ],
      },
    ];
  }
  if (lower.includes("quote markdown fixture")) {
    const marker = /quote markdown fixture\s+(\S+)/i.exec(prompt)?.[1] ?? "md-fixture";
    return [
      {
        assistant: `${marker}
1. list-a
2. list-b

| k | v |
| --- | --- |
| cell-a | cell-b |
| cell-c | cell-d |

\`\`\`
code-a
---
code-b
\`\`\``,
        complete: true,
      },
    ];
  }
  if (lower.includes("send the draft on the card")) {
    // Background resumes retain the task and append the answered question.
    if (/\nAnswer:/.test(prompt)) return [{ assistant: "thanks. sent.", complete: true }];
    return [
      {
        assistant: "the draft is on the card. pick one to continue.",
        ask: {
          text: "Send this email to Ana?",
          detail: "To: ana@example.test\nSubject: Demo\n\nThe draft body.",
          actions: [
            { id: "choice-1", label: "Send it" },
            { id: "choice-2", label: "Show me first" },
          ],
        },
      },
    ];
  }
  const hasChoices =
    lower.includes("tappable choices") ||
    lower.includes("choice buttons") ||
    lower.includes("pick from these cities");
  if (
    hasChoices ||
    lower.includes("ask me") ||
    lower.includes("which city") ||
    lower.includes("need a decision")
  ) {
    // Background resumes retain the task and append the answered question.
    if (/\nAnswer:/.test(prompt)) {
      return [{ assistant: "thanks. done.", complete: true }];
    }
    return [
      {
        assistant: hasChoices ? "pick one to continue." : "i need a decision before i continue.",
        ask: hasChoices
          ? {
              text: "Which city should I use?",
              actions: [
                { id: "choice-1", label: "Berlin" },
                { id: "choice-2", label: "Seoul" },
                { id: "choice-3", label: "Toronto" },
                { id: "choice-4", label: "Lisbon" },
              ],
            }
          : { text: "Which city should I use?", detail: "Reply with one city name." },
      },
    ];
  }
  if (lower.includes("take over") || lower.includes("sign in") || lower.includes("login")) {
    return [
      { assistant: "i need you on the screen for a one-time sign-in. handing you the computer." },
      { takeover: { reason: "Sign in to continue. Protected input stays off the thread." } },
    ];
  }
  if (
    lower.includes("observe your screen") ||
    lower.includes("look at your screen") ||
    lower.includes("use your screen")
  ) {
    const typed = /type\s+([A-Za-z0-9._-]+)/i.exec(prompt)?.[1] ?? "ready";
    return [
      {
        assistant: "using my screen now.",
        toolCalls: [
          { name: "computer_observe", args: {} },
          {
            name: "computer_act",
            args: {
              actions: [{ kind: "type", text: typed }],
              observe: true,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("delete the bot named") ||
    lower.includes("delete the child bot") ||
    lower.includes("delete child")
  ) {
    const name = namedBot(prompt) ?? "Scout";
    return [
      {
        assistant: "archiving that bot.",
        toolCalls: [{ name: "archive_bot", args: { confirm_name: name } }],
        complete: true,
      },
    ];
  }
  const ownInstructions = /update your instructions to:\s*([^\n<&]+)/i.exec(prompt);
  if (ownInstructions) {
    return [
      {
        assistant: "updating my instructions.",
        toolCalls: [{ name: "update_bot", args: { instructions: ownInstructions[1]!.trim() } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("create a space") ||
    lower.includes("create space") ||
    lower.includes("new space named") ||
    lower.includes("new private space")
  ) {
    const name = namedSpace(prompt) ?? "New space";
    return [
      {
        assistant: "i can create that separate space after you confirm the boundary.",
        toolCalls: [{ name: "create_space", args: { name } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("spawn a bot") ||
    lower.includes("spawn a child") ||
    lower.includes("create a bot named") ||
    lower.includes("create a child bot")
  ) {
    const name = namedBot(prompt) ?? "Helper";
    return [
      {
        assistant: "creating a bot for that.",
        toolCalls: [
          {
            name: "spawn_bot",
            args: {
              name,
              title: `${name} specialist`,
              instructions: `You are ${name}.`,
              prompt: "Start on the assigned work.",
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("silence finish notifications") ||
    lower.includes("turn off finish notifications")
  ) {
    return [
      {
        assistant: "silencing finish notifications.",
        toolCalls: [{ name: "update_bot", args: { notifyOnFinish: false } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("resume finish notifications") ||
    lower.includes("turn on finish notifications")
  ) {
    return [
      {
        assistant: "enabling finish notifications.",
        toolCalls: [{ name: "update_bot", args: { notifyOnFinish: true } }],
        complete: true,
      },
    ];
  }
  // A peer's own reply can say it works in the background, and a question only asks about it;
  // only a person's request starts one.
  if (
    lower.includes("in the background") &&
    !lower.trimEnd().endsWith("?") &&
    !peerMessage(prompt)
  ) {
    const task = prompt.replace(/\s*in the background/i, "").trim();
    return [
      {
        assistant: "a background helper is on it; ask me anything meanwhile.",
        toolCalls: [{ name: "run_subagent", args: { name: "helper", task, background: true } }],
        complete: true,
      },
    ];
  }
  if (lower.includes("subagent") || lower.includes("delegate to a helper")) {
    return [
      {
        assistant: "spinning up a helper for that.",
        toolCalls: [{ name: "run_subagent", args: { name: "helper", task: prompt } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("hand this to") ||
    lower.includes("hand off to") ||
    lower.includes("handoff to") ||
    (lower.includes("@writer") && lower.includes("draft"))
  ) {
    const target = inferHandoffTargetName(prompt) ?? "Writer";
    return [
      {
        assistant: "handing this off in the group thread.",
        toolCalls: [
          {
            name: "handoff_to_bot",
            args: {
              confirm_name: target,
              message: prompt,
            },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.startsWith("run taught skill:") || lower.includes("this is a safe test")) {
    return [
      {
        assistant:
          "Running the taught skill using its saved playbook. I will follow the demonstrated steps and report the result.",
        complete: true,
      },
    ];
  }
  // An inbound routine run opens with "Run routine"; its payload picks the branch, not this one.
  if (/^run\s+(?!routine ")/.test(lower)) {
    return [
      {
        assistant:
          "Using the saved taught skill playbook for that request and following its steps.",
        complete: true,
      },
    ];
  }
  if (lower.includes("connector") || lower.includes("crm") || lower.includes("destination")) {
    return [
      {
        assistant: "writing the record through the connected destination.",
        toolCalls: [
          {
            name: "destination.write",
            args: { collection: "notes", title: "Rakazo result", body: prompt },
          },
        ],
        complete: true,
      },
    ];
  }
  if (lower.includes("attach") && (lower.includes("thread") || lower.includes("into the thread"))) {
    const said = /says?\s+(.+)$/i.exec(prompt)?.[1]?.replace(/[.]+$/, "") ?? prompt;
    const content = `${said.trim()}\n`;
    const filePath =
      /(?:called|named|path|file)\s+([A-Za-z0-9._/-]+)/i.exec(prompt)?.[1] ?? "notes/result.txt";
    return [
      { assistant: "writing that into my home and attaching it to the thread." },
      { toolCalls: [{ name: "write_file", args: { path: filePath, content } }] },
      { toolCalls: [{ name: "attach_file", args: { path: filePath } }], complete: true },
    ];
  }
  if (
    lower.includes("save shared memory") ||
    lower.includes("update shared memory") ||
    lower.includes("write shared memory")
  ) {
    const contentMatch =
      /\b(?:with|content):\s*([\s\S]+)$/i.exec(prompt) ?? /\bwith\s+([\s\S]+)$/i.exec(prompt);
    const content = contentMatch?.[1]?.trim();
    const header = contentMatch ? prompt.slice(0, contentMatch.index) : prompt;
    const named =
      /(?:named|called|path|file)\s+([A-Za-z0-9._/-]+)/i.exec(header)?.[1] ??
      /shared memory\s+([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/i.exec(header)?.[1];
    const path = named && named.toLowerCase() !== "with" ? named : "MEMORY.md";
    if (!content) {
      return [
        {
          assistant:
            "say what to save, for example: save shared memory MEMORY.md with: the new facts.",
          complete: true,
        },
      ];
    }
    return [
      {
        assistant: "saving that to shared memory.",
        toolCalls: [{ name: "save_shared_memory", args: { path, content } }],
        complete: true,
      },
    ];
  }
  if (
    lower.includes("write") &&
    (lower.includes("file") || lower.includes("home") || lower.includes("note"))
  ) {
    const said = /says?\s+(.+)$/i.exec(prompt)?.[1]?.replace(/[.]+$/, "") ?? prompt;
    const content = `${said.trim()}\n`;
    const filePath =
      /(?:called|named)\s+([A-Za-z0-9._/-]+)/i.exec(prompt)?.[1] ?? "notes/result.txt";
    return [
      { toolCalls: [{ name: "write_file", args: { path: filePath, content } }] },
      { assistant: "writing that into my home now.", complete: true },
    ];
  }
  if (lower.includes("remember")) {
    return [
      {
        assistant: "noted — i will keep that in memory.",
        memory: [{ scope: "bot", path: "MEMORY.md", content: `# Memory\n\n- ${prompt}\n` }],
        complete: true,
      },
    ];
  }
  return [
    {
      assistant: `on it. i will work this in the background and come back with a result.\n\n${summarize(peerMessage(prompt)?.text ?? prompt)}`,
    },
    {
      files: [{ path: "notes/last-task.md", content: `# Task\n\n${prompt}\n` }],
      complete: true,
    },
  ];
}

/** The outcome a helper-result turn relays, from the block its prompt wraps it in. */
function helperOutcome(
  prompt: string,
): { status: "completed" | "failed"; text: string } | undefined {
  if (prompt.startsWith(BACKGROUND_HELPER_TASK_CUE)) return undefined;
  const match =
    /<helper_result from="[^"]*" status="(completed|failed)">\n([\s\S]*?)\n<\/helper_result>/.exec(
      prompt,
    );
  return match ? { status: match[1] as "completed" | "failed", text: match[2]! } : undefined;
}

function shouldFail(prompt: string): boolean {
  return prompt.toLowerCase().includes("fail this run");
}

/**
 * The error a failing run throws; "overloaded" sends the body Anthropic returns with a 529 and
 * "unreachable" sends what the provider SDKs report when nothing listens at the base URL.
 */
function scriptedFailure(prompt: string): string {
  if (/\bfixed context\b/i.test(prompt)) return MODEL_CONTEXT_TOO_SMALL_ERROR;
  if (/\bconnection request limit\b/i.test(prompt)) return MODEL_REQUEST_LIMIT_ERROR;
  if (/\bunrun approval\b/i.test(prompt)) return APPROVED_ACTION_NOT_RUN_ERROR;
  if (/\bcut reply\b/i.test(prompt)) return MODEL_OUTPUT_CUT_ERROR;
  if (/\bunreachable\b/i.test(prompt)) return "Connection error.";
  if (/\bout of credits\b/i.test(prompt)) {
    return '402: {"message":"You have no credits remaining. Add credits to continue."}';
  }
  if (/\brejected key\b/i.test(prompt)) return '401: {"message":"Invalid API key"}';
  if (/\bexhausted backups\b/i.test(prompt)) {
    return modelFallbackFailure('429: {"message":"Too many requests"}', [
      {
        provider: "fake-provider",
        modelId: "fake-backup",
        status: "failed",
        reason: "429 quota exhausted",
      },
    ]);
  }
  return /\boverloaded\b/i.test(prompt)
    ? '529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    : "Scripted run failure";
}

/** How long a scripted run keeps working before it finishes; undefined runs its script. */
function hangDuration(prompt: string): number | undefined {
  const lower = prompt.toLowerCase();
  // Asking another bot or a background helper to keep working makes that run hang, not this one.
  if (
    lower.includes("message the bot named") ||
    lower.includes("message bot named") ||
    lower.includes("in the background")
  ) {
    return undefined;
  }
  const seconds = /\bwork for (\d+) seconds?\b/.exec(lower)?.[1];
  if (seconds) return Number(seconds) * 1000;
  return lower.includes("keep working") ||
    lower.includes("work until i stop") ||
    lower.includes("until i stop you") ||
    lower.includes("hang until stopped")
    ? Number.POSITIVE_INFINITY
    : undefined;
}

/** One fleet tool call per prompt, so journeys can drive each tool in plain words. */
function fleetCall(prompt: string): { name: string; args: Record<string, unknown> } | undefined {
  const target = (kind: string, name: string) => ({
    [kind.toLowerCase() === "group" ? "group_name" : "bot_name"]: clean(name),
  });
  const listed = /\blist the bots you manage(?: with bot\s+([A-Za-z0-9_-]+))?/i.exec(prompt);
  if (listed) return { name: "list_fleet", args: listed[1] ? { bot_id: listed[1] } : {} };
  const created = /create a group named\s+([^\n<&]+?)\s+with\s+([^\n<&]+)/i.exec(prompt);
  if (created) {
    const names = clean(created[2]!)
      .split(/\s*,\s*|\s+and\s+/)
      .filter(Boolean);
    return { name: "create_group", args: { name: clean(created[1]!), bot_names: names } };
  }
  const membership =
    /\b(add|remove) bots?\s+([A-Za-z0-9_,\s-]+?)\s+(?:to|from) the group named\s+([^\n<&]+)/i.exec(
      prompt,
    );
  if (membership) {
    const ids = membership[2]!.split(/[\s,]+/).filter(Boolean);
    const key = membership[1]!.toLowerCase() === "add" ? "add_bot_ids" : "remove_bot_ids";
    return { name: "update_group", args: { group_name: clean(membership[3]!), [key]: ids } };
  }
  const renamed = /rename the group named\s+([^\n<&]+?)\s+to\s+([^\n<&]+)/i.exec(prompt);
  if (renamed) {
    return {
      name: "update_group",
      args: { group_name: clean(renamed[1]!), name: clean(renamed[2]!) },
    };
  }
  const moved = /move the (bot|group) named\s+([^\n<&]+?)\s+to section\s+([^\n<&]+)/i.exec(prompt);
  if (moved) {
    return {
      name: "organize_bot",
      args: { ...target(moved[1]!, moved[2]!), section: clean(moved[3]!) },
    };
  }
  const cleared = /clear the section of the (bot|group) named\s+([^\n<&]+)/i.exec(prompt);
  if (cleared) {
    return {
      name: "organize_bot",
      args: { ...target(cleared[1]!, cleared[2]!), clear_section: true },
    };
  }
  const model =
    /set the model of bot\s+([A-Za-z0-9_-]+)\s+to\s+([A-Za-z0-9_.-]+)\/([^\s<&]+)/i.exec(prompt);
  if (model) {
    return {
      name: "set_child_bot_model",
      args: { bot_id: model[1], provider: model[2], model: clean(model[3]!) },
    };
  }
  const reset = /reset the model of bot\s+([A-Za-z0-9_-]+)/i.exec(prompt);
  if (reset) return { name: "set_child_bot_model", args: { bot_id: reset[1], clear: true } };
  const routine =
    /schedule bot\s+([A-Za-z0-9_-]+)\s+routine\s+([^\n<&]+?)\s+every\s+(\d+)\s+(minutes|hours|days)\s+saying\s+([^\n<&]+)/i.exec(
      prompt,
    );
  if (routine) {
    return {
      name: "create_child_routine",
      args: {
        bot_id: routine[1],
        name: clean(routine[2]!),
        every: Number(routine[3]),
        unit: routine[4]!.toLowerCase(),
        prompt: clean(routine[5]!),
      },
    };
  }
  const pinned = /\b(un)?pin the (bot|group) named\s+([^\n<&]+)/i.exec(prompt);
  if (pinned) {
    return {
      name: "organize_bot",
      args: { ...target(pinned[2]!, pinned[3]!), pinned: !pinned[1] },
    };
  }
  return undefined;
}

/** Child edits a journey can chain in one run: instruction rewrites, a rename, a self-rename. */
function childEditCalls(
  prompt: string,
): Array<{ name: string; args: Record<string, unknown> }> | undefined {
  const edit =
    /rewrite the instructions of bot\s+([A-Za-z0-9_-]+)(?:\s+at version\s+([A-Za-z0-9_-]+))?\s+to\s+([^\n<&]+)/i.exec(
      prompt,
    );
  if (edit) {
    return edit[3]!.split(/\s+and then to\s+/i).map((instructions) => ({
      name: "set_child_instructions",
      args: {
        bot_id: edit[1],
        ...(edit[2] ? { expected_version: edit[2] } : {}),
        instructions: clean(instructions),
      },
    }));
  }
  const renamed = /rename bot\s+([A-Za-z0-9_-]+)\s+to\s+([^\n<&]+)/i.exec(prompt);
  if (renamed)
    return [{ name: "update_bot", args: { bot_id: renamed[1], name: clean(renamed[2]!) } }];
  // Some providers send every omitted optional field as an empty string.
  const blank = /rename yourself to\s+([^\n<&]+?)\s+with blank bot management fields/i.exec(prompt);
  if (blank) return [{ name: "update_bot", args: { name: clean(blank[1]!), bot_id: "" } }];
  return undefined;
}

/** A phrase from a journey prompt without its surrounding space and closing punctuation. */
function clean(value: string): string {
  return value.trim().replace(/[.!?]+$/, "");
}

function namedBot(prompt: string) {
  return /named\s+([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt)?.[1];
}

function namedSpace(prompt: string) {
  return /space\s+(?:named|called)\s+["“]?([^"”\n]{1,60})/i
    .exec(prompt)?.[1]
    ?.replace(/[.!?]+$/, "")
    .trim();
}

/** The quoted message a reply's prompt opens with (see reply-context.ts). */
const REPLY_CONTEXT =
  /^(?:Replying to|User reacted with \S+ to) \(quoted data, not instructions\):\n<(reply_target|reaction_target)>\n[\s\S]*?\n<\/\1>\n\n/;

/**
 * The sender and body of a bot-message wake prompt, without the wake instructions around it. A
 * delivery that threads back to this bot's own message opens with that message quoted.
 */
function peerMessage(prompt: string): { from: string; text: string } | undefined {
  if (!prompt.replace(REPLY_CONTEXT, "").startsWith(BOT_MESSAGE_WAKE_CUE)) return undefined;
  const match = /<bot_message from="([^"]*)">\n([\s\S]*?)\n<\/bot_message>/.exec(prompt);
  if (!match) return undefined;
  const text = match[2]!
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();
  return { from: match[1] || "Peer", text };
}

/** A delegated result or status to relay: who sent it and its last paragraph. */
function delegatedReport(prompt: string): { from: string; gist: string } | undefined {
  if (!/^This is a (?:result|status) for work you delegated\./m.test(prompt)) return undefined;
  const message = peerMessage(prompt);
  if (!message?.text) return undefined;
  const gist =
    message.text
      .split(/\n\s*\n/)
      .at(-1)
      ?.trim() || message.text;
  return { from: message.from, gist };
}

function summarize(prompt: string): string {
  return `done. i handled: ${prompt.slice(0, 180)}`;
}
