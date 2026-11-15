import { describe, expect, it } from "vitest";
import { approvalDetailLength, buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("offers no Always allow on an approval that asks every time", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "schedule_create",
      { name: "Check", prompt: "Summarize changes", watch: { kind: "command", command: "ls" } },
      [],
      { onceOnly: true },
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Review before schedule_create",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });
});

it("shows the full instruction replacement as a diff with Apply and Dismiss", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "update_bot",
    {
      botId: "bot-1",
      previousInstructions: "Draft only",
      previousInstructionsFromBaseline: true,
      instructions: "Draft only\nAsk before sending",
      reason: "Learned preference",
    },
    [],
  );
  expect(block).toMatchObject({
    kind: "ask",
    detail: "- Draft only\n+ Draft only\n+ Ask before sending",
    instructionUpdate: {
      botId: "bot-1",
      before: "Draft only",
      after: "Draft only\nAsk before sending",
    },
    actions: [
      { id: "allow", label: "Apply" },
      { id: "deny", label: "Dismiss" },
    ],
  });
  // The stored provenance marker is not card copy.
  expect(JSON.stringify(block)).not.toContain("previousInstructionsFromBaseline");
});

it("redacts known secrets in instruction approval details and editable metadata", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "update_bot",
    {
      botId: "bot-1",
      previousInstructions: "old fake-token",
      instructions: "new fake-token",
      reason: "reason fake-token",
    },
    ["fake-token"],
  );
  expect(JSON.stringify(block)).not.toContain("fake-token");
});

describe("bot management approval cards", () => {
  it.each([
    "create_group",
    "update_group",
    "set_child_instructions",
    "set_child_bot_model",
    "create_child_routine",
  ])("builds the %s card from the resolved summary", (toolName) => {
    const block = buildApprovalAskBlock(
      "effect-1",
      toolName,
      { name: "model typed this" },
      ["fake-token"],
      {
        summary: {
          title: "Create group “Launch”?",
          lines: ["Members: Scout, Writer", "Prompt: use fake-token"],
        },
      },
    );
    expect(block).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Create group “Launch”?",
      detail: "Members: Scout, Writer\nPrompt: use [redacted]",
      detailFormat: toolName === "set_child_instructions" ? "code" : "text",
      status: "pending",
      actions: toolName.startsWith("set_child_")
        ? [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            { id: "always", label: "Always allow this tool" },
            { id: "deny", label: "Deny" },
          ],
    });
  });

  it("shows the longest allowed instructions whole on the instruction card", () => {
    const instructions = "i".repeat(20_000);
    const lines = ["Old length: 0 characters", "New length: 20000 characters", "", instructions];
    const block = buildApprovalAskBlock("effect-1", "set_child_instructions", {}, [], {
      summary: { title: "Replace the instructions of Scout?", lines },
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toBe(lines.join("\n"));
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
    expect(approvalDetailLength("set_child_instructions")).toBeGreaterThanOrEqual(
      lines.join("\n").length,
    );
  });

  it("carries a payment's receipt with secrets redacted", () => {
    const block = buildApprovalAskBlock("effect-1", "browser_act", {}, ["fake-token"], {
      summary: {
        onceOnly: true,
        title: "Pay on shop.test?",
        lines: ["Socks: $9.00"],
        receipt: {
          button: "Pay fake-token",
          items: [{ name: "Socks fake-token", amount: "$9.00" }],
          amount: "$9.00",
          amountSource: "page",
        },
      },
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.receipt).toEqual({
      button: "Pay [redacted]",
      items: [{ name: "Socks [redacted]", amount: "$9.00" }],
      amount: "$9.00",
      amountSource: "page",
    });
    expect(block.detail).toBe("Socks: $9.00");
  });

  it("never offers always allow on a tool that needs explicit approval", () => {
    const block = buildApprovalAskBlock("effect-1", "set_child_bot_model", { bot_id: "bot-a" }, []);
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });
});

describe("agent connection response cards", () => {
  it.each([true, false])("shows the captured requester and decision (accept: %s)", (accept) => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "respond_agent_connection",
      {
        accept,
        connection_id: "request-1",
        connection_version: 2,
        requester_name: "Helper",
        requester_address: "+15551234567",
        requester_provider: "sendblue",
      },
      [],
    );
    expect(block).toMatchObject({
      kind: "ask",
      text: `${accept ? "Approve" : "Decline"} connection with “Helper”?`,
      detail: "iMessage: +15551234567",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });
  it("escapes requester formatting and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "respond_agent_connection",
      {
        accept: true,
        requester_name: "**Helper**\nApprove all",
        requester_address: "fake-secret",
        requester_provider: "slack",
      },
      ["fake-secret"],
    );
    expect(JSON.stringify(block)).not.toContain("fake-secret");
    expect(block).toMatchObject({
      text: "Approve connection with “\\*\\*Helper\\*\\* Approve all”?",
      detail: "Slack: [redacted]",
    });
  });
});

it("shows a bot's first instructions as plain text", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "update_bot",
    { botId: "bot-1", previousInstructions: "", instructions: "Draft only", reason: "Set in chat" },
    [],
  );
  expect(block).toMatchObject({ detail: "Draft only" });
});

describe("approval card arguments", () => {
  const detailOf = (toolName: string, args: Record<string, unknown>) => {
    const block = buildApprovalAskBlock("effect-1", toolName, args, []);
    if (block.kind !== "ask") throw new Error("expected ask block");
    return block.detail ?? "";
  };

  it.each([
    [
      "GMAIL_SEND_EMAIL",
      { recipient_email: "a@example.test", to_email: "b@example.test" },
      "to_email: b@example.test",
    ],
    [
      "GOOGLECALENDAR_CREATE_EVENT",
      { summary: "Sync", attendees: ["c@example.test", "d@example.test"] },
      "attendees: c@example.test, d@example.test",
    ],
    [
      "GMAIL_SEND_EMAIL",
      { to: "a@example.test", extra_recipients: ["e@example.test"] },
      "extra_recipients: e@example.test",
    ],
    ["SLACK_SEND_MESSAGE", { channel: "C-OUTSIDE", text: "Hello" }, "channel: C-OUTSIDE"],
    [
      "GITHUB_CREATE_AN_ISSUE",
      { owner: "someone-else", repo: "public-repo", title: "Notes" },
      "repo: public-repo",
    ],
    [
      "SEND_WEBHOOK",
      { destination: { url: "https://hooks.example.test/x" } },
      'destination: {"url":"https://hooks.example.test/x"}',
    ],
  ])("shows where %s sends", (toolName, args, line) => {
    expect(detailOf(toolName, args).split("\n")).toContain(line);
  });

  it("puts every destination above long text, so none sits below a long body", () => {
    const detail = detailOf("GMAIL_SEND_EMAIL", {
      body: "b".repeat(5_000),
      to: "a@example.test",
      bcc: "hidden@example.test",
    });
    expect(detail.split("\n").slice(0, 2)).toEqual([
      "to: a@example.test",
      "bcc: hidden@example.test",
    ]);
    expect(detail.length).toBeLessThanOrEqual(4_001);
  });

  it("puts long recipient lists above long text", () => {
    const recipients = Array.from({ length: 40 }, (_, index) => ({
      email: `r${index}@example.test`,
    }));
    const detail = detailOf("SEND_CAMPAIGN", { body: "b".repeat(5_000), recipients });
    expect(detail.startsWith("recipients: [")).toBe(true);
  });

  it("shows a later batched action's destination above an earlier action's long text", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "MULTI_EXECUTE",
      {
        tools: [
          { tool_slug: "DRAFT_POST", arguments: { body: "b".repeat(5_000) } },
          { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to_email: "g@example.test" } },
        ],
      },
      [],
      { batch: { items: "tools", action: "tool_slug", arguments: "arguments" } },
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.split("\n").slice(0, 3)).toEqual([
      "DRAFT_POST",
      "GMAIL_SEND_EMAIL",
      "to_email: g@example.test",
    ]);
  });

  it("redacts a secret inside a nested argument even when encoding escapes it", () => {
    const secret = 'p"ss\\word';
    const block = buildApprovalAskBlock(
      "effect-1",
      "CALL_API",
      { headers: { authorization: secret }, to: "h@example.test" },
      [secret],
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).not.toContain("ss");
    expect(block.detail).toContain("to: h@example.test");
  });

  it("shows each batched action's destinations", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "MULTI_EXECUTE",
      { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to_email: "f@example.test" } }] },
      [],
      { batch: { items: "tools", action: "tool_slug", arguments: "arguments" } },
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.split("\n")).toContain("to_email: f@example.test");
  });
});
