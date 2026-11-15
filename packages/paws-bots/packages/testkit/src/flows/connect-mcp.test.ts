import { McpSession } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type { TrackerState } from "./connect-mcp.js";
import { connectMcp, startTaskTracker } from "./connect-mcp.js";
import type { FlowEvidence, TranscriptEntry } from "./flow.js";
import { cardText, mcpApprovalAsk } from "./runner.js";

type World = Parameters<typeof connectMcp.grade>[0]["world"];

/** Connects the way the product's MCP connector does to a loopback HTTP server. */
async function connect(endpoint: string, headers: Record<string, string>) {
  const session = new McpSession();
  await session.connectRemote({
    url: endpoint,
    urlPolicy: {
      allowHttpLocalhost: true,
      allowLocalHttpCredentials: true,
      allowPrivateEndpoint: true,
    },
    headerPolicy: { headers },
    fallbackToSse: false,
  });
  return session;
}

describe("the task tracker's MCP server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("serves the product's MCP session with the bearer token", async () => {
    const tracker = await startTaskTracker("tl_secret");
    close = tracker.close;
    const session = await connect(tracker.endpoint, { Authorization: "Bearer tl_secret" });
    try {
      const { tools } = await session.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["list_tasks", "add_task"]);
      await session.callTool("add_task", { title: "Renew passport", due: "2026-10-30" });
      const listed = await session.callTool("list_tasks");
      const text = (listed.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain("Pay water bill");
      expect(text).toContain("Renew passport");
    } finally {
      await session.close();
    }
    expect(tracker.state.tasks.at(-1)).toMatchObject({
      title: "Renew passport",
      due: "2026-10-30",
    });
    expect(tracker.state.calls.map((call) => call.name)).toEqual(["add_task", "list_tasks"]);
  });

  it.each([
    ["a missing", {}],
    ["a wrong", { Authorization: "Bearer tl_wrong" }],
  ])("refuses %s token", async (_name, headers: Record<string, string>) => {
    const tracker = await startTaskTracker("tl_secret");
    close = tracker.close;
    const session = await connect(tracker.endpoint, headers).catch(() => undefined);
    await session?.close();
    expect(session).toBeUndefined();
    expect(tracker.state.calls).toEqual([]);
  });
});

describe("grading connect-mcp", () => {
  const endpoint = "http://127.0.0.1:41234/mcp";
  const at = (minute: number) => `2026-10-26T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const ask = mcpApprovalAsk({
    kind: "mcp_approval",
    name: "Tasklog",
    serverId: "server",
    transport: "streamable_http",
    endpoint,
    needsOAuth: false,
    status: "pending",
  });
  const card: TranscriptEntry = {
    from: "bot",
    text: `Please approve Tasklog.\n${cardText(ask)}`,
    at: at(1),
  };
  const approved: TranscriptEntry = { from: "user", text: "[pressed Approve]", at: at(2) };
  const done: TrackerState = {
    tasks: [
      ...["Book dentist check-up", "Pay water bill", "Return library books"].map(
        (title, index) => ({
          id: `T-${index + 1}`,
          title,
          due: null,
          done: false,
          createdAt: new Date(0).toISOString(),
        }),
      ),
      {
        id: "T-4",
        title: "Renew passport",
        due: "2026-10-30",
        done: false,
        createdAt: at(3),
      },
    ],
    calls: [
      { name: "add_task", arguments: { title: "Renew passport" }, at: at(3) },
      { name: "list_tasks", arguments: {}, at: at(3) },
    ],
  };

  function evidence(transcript: TranscriptEntry[], tracker: TrackerState): FlowEvidence<World> {
    return {
      world: { endpoint, token: "tl_secret", tracker },
      transcript,
      routines: [],
      toolNames: [],
      observations: { conversation: tracker },
      endedBy: "user-done",
    };
  }
  const failed = (transcript: TranscriptEntry[], tracker: TrackerState) =>
    connectMcp
      .grade(evidence(transcript, tracker))
      .filter((criterion) => !criterion.pass)
      .map((criterion) => criterion.id);

  it("passes when the bot carries on with the tracker after the approval", () => {
    const reply: TranscriptEntry = { from: "bot", text: "Added. Also open: ...", at: at(4) };
    expect(failed([card, approved, reply], done)).toEqual([]);
  });

  it("counts allowing the bot's own tool approval as carrying on", () => {
    const toolCard: TranscriptEntry = {
      from: "bot",
      text: "[card] Review before mcp__tasklog__add_task → Renew passport",
      at: at(2),
    };
    const allowed: TranscriptEntry = {
      from: "user",
      text: "[pressed Allow once]",
      at: at(2),
      toolApproval: true,
    };
    expect(failed([card, approved, toolCard, allowed], done)).toEqual([]);
  });

  it.each([
    ["pressing a button on the bot's question", "[pressed Yes]"],
    ["typing a bracketed message", "[please continue]"],
  ])("fails carrying on after %s", (_name, text) => {
    const nudge: TranscriptEntry = { from: "user", text, at: at(2) };
    expect(failed([card, approved, nudge], done)).toEqual(["carried-on-after-approval"]);
  });

  it("fails carrying on when the tracker was only used after the person nudged", () => {
    const nudge: TranscriptEntry = { from: "user", text: "hello? did it work", at: at(2) };
    expect(failed([card, approved, nudge], done)).toEqual(["carried-on-after-approval"]);
  });

  it("fails without an approved card for this server", () => {
    const otherServer = { ...card, text: card.text.replace("41234", "9999") };
    expect(failed([otherServer, approved], done)).toEqual([
      "approval-card-shown",
      "approval-card-approved",
      "carried-on-after-approval",
    ]);
    const dismissed = { ...approved, text: "[pressed Not now]" };
    expect(failed([card, dismissed], done)).toEqual([
      "approval-card-approved",
      "carried-on-after-approval",
    ]);
  });

  it("calibrates the judge on its own rubric with passing and failing labels", () => {
    const { rubric } = connectMcp.judge!(evidence([card, approved], done));
    const labels = connectMcp.judgeCalibration ?? [];
    expect(labels.every((label) => label.input.rubric === rubric)).toBe(true);
    expect(labels.map((label) => label.pass)).toEqual([true, false, false, false, true, false]);
  });

  it("runs every label's tools after the approval and before the reply", () => {
    for (const label of connectMcp.judgeCalibration ?? []) {
      const { transcript, tracker } = label.input.evidence as {
        transcript: TranscriptEntry[];
        tracker: { calls: Array<{ at: string }> };
      };
      const pressed = transcript.find((entry) => entry.text === "[pressed Approve]")!.at;
      const reply = transcript.at(-1)!.at;
      for (const call of tracker.calls) {
        expect(call.at > pressed && call.at < reply).toBe(true);
      }
    }
  });

  it("gives the judge the person's timezone, in the run and in every label", () => {
    const { evidence: judged } = connectMcp.judge!(evidence([card, approved], done));
    expect(judged).toMatchObject({ timezone: connectMcp.timezone });
    for (const label of connectMcp.judgeCalibration ?? []) {
      expect(label.input.evidence).toMatchObject({ timezone: connectMcp.timezone });
    }
  });

  it("fails a duplicated task, an unread list and a repeated token", () => {
    const twice: TrackerState = {
      ...done,
      // Same request worded twice; counting records catches it whatever the titles say.
      tasks: [...done.tasks, { ...done.tasks.at(-1)!, id: "T-5", title: "Renew travel document" }],
      calls: done.calls.filter((call) => call.name !== "list_tasks"),
    };
    const leak: TranscriptEntry = { from: "bot", text: "Connected with tl_secret", at: at(4) };
    expect(failed([card, approved, leak], twice)).toEqual([
      "task-added-once",
      "list-read",
      "token-not-repeated",
    ]);
  });
});
