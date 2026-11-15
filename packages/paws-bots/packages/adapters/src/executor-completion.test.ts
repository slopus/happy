import { ModelOutputError } from "@rakazo/adapter-kit";
import { MISSING_TOOL_FINAL_RESPONSE_ERROR } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { runIdentityInstruction } from "./run-instructions.js";
import { mayOpenModelStream } from "./run-lifecycle.js";
import {
  completionMarksUnread,
  completionNotificationBody,
  completionNotificationPreview,
  runSendsFinishNotification,
  secretAskNotification,
  subagentMarksUnread,
} from "./run-notifications.js";
import {
  completionMessageSegments,
  DELEGATED_EMPTY_NOTICE,
  emptyDelegatedToolTurnShouldFail,
  longWorkProgressGuidance,
  messagesModeReplyGuidance,
  REACTION_SILENT_REPLY_GUIDANCE,
  ROUTINE_SILENT_REPLY_GUIDANCE,
  runAllowsSilentEmpty,
  runPromotesMidTurnNarration,
  runReplyGuidance,
  runReplyMode,
  TICKET_SILENT_REPLY_GUIDANCE,
} from "./run-replies.js";
import { handoffEndedTurn } from "./run-turn.js";
import {
  couldBecomeNoResponse,
  isExactNoResponse,
  isNoResponseReply,
  isPlaceholderReply,
  NO_RESPONSE,
  stripNoResponseReply,
  stripStrayNoResponse,
} from "./silent-reply.js";
import { finalBlocksAfterMidTurnProgress } from "./user-progress.js";

describe("completionMessageSegments", () => {
  it("keeps visible tool activity without appending a generic completion claim", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Message bot", count: 1 }] }];
    expect(completionMessageSegments(steps)).toEqual(steps);
  });

  it("keeps the last-resort fallback for a runtime that produced nothing", () => {
    expect(completionMessageSegments([])).toEqual([{ kind: "text", text: "done." }]);
  });

  it("allows a fully empty completion for silent bot-message wakes", () => {
    expect(completionMessageSegments([], { allowSilentEmpty: true })).toEqual([]);
  });

  it("drops narration after a successful group handoff", () => {
    expect(
      completionMessageSegments([{ kind: "text", text: "Research is checking this." }], {
        suppressOutput: true,
      }),
    ).toEqual([]);
  });

  it("uses a contextual fallback for a non-silent peer result", () => {
    expect(
      completionMessageSegments([], { emptyResponseText: "Update from Researcher: 42" }),
    ).toEqual([{ kind: "text", text: "Update from Researcher: 42" }]);
  });

  it("keeps a peer result visible when the runtime emitted only tool activity", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(
      completionMessageSegments(steps, { emptyResponseText: "Update from Researcher: 42" }),
    ).toEqual([...steps, { kind: "text", text: "Update from Researcher: 42" }]);
  });

  it("does not append fallback text to a tool-only FYI", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(
      completionMessageSegments(steps, {
        allowSilentEmpty: true,
        emptyResponseText: "synthetic text",
      }),
    ).toEqual(steps);
  });

  it("normalizes a blank fallback", () => {
    expect(completionMessageSegments([], { emptyResponseText: "   " })).toEqual([
      { kind: "text", text: "done." },
    ]);
  });

  it("fails a tool turn whose only completion text is the empty delegated notice", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    const blocks = completionMessageSegments(steps, { emptyResponseText: DELEGATED_EMPTY_NOTICE });
    expect(blocks).toEqual([...steps, { kind: "text", text: DELEGATED_EMPTY_NOTICE }]);
    expect(emptyDelegatedToolTurnShouldFail(blocks)).toBe(true);
    expect(emptyDelegatedToolTurnShouldFail(steps)).toBe(false);
    expect(emptyDelegatedToolTurnShouldFail([{ kind: "text", text: DELEGATED_EMPTY_NOTICE }])).toBe(
      false,
    );
    expect(
      emptyDelegatedToolTurnShouldFail(
        completionMessageSegments(steps, { emptyResponseText: "Update from Researcher: 42" }),
      ),
    ).toBe(false);
  });
});

describe("completionNotificationBody", () => {
  it("omits a body when only tool or step activity remains", () => {
    const steps = completionMessageSegments([
      { kind: "steps" as const, steps: [{ label: "Message bot", count: 1 }] },
    ]);
    expect(completionNotificationBody("", steps)).toBe("");
  });

  it("uses the empty-run text when that is all the run produced", () => {
    expect(completionNotificationBody("", completionMessageSegments([]))).toBe("done.");
  });
});

describe("completionNotificationPreview", () => {
  it("preserves the actual address in an autolink notification", () => {
    expect(completionNotificationPreview("Contact <_ops_@example.test> **today**")).toBe(
      "Contact _ops_@example.test today",
    );
  });
  it("preserves filenames in completion notifications", () => {
    expect(completionNotificationPreview("Saved **monthly_sales_report.csv**")).toBe(
      "Saved monthly_sales_report.csv",
    );
  });
  it("strips Markdown and truncates the plain text", () => {
    expect(completionNotificationPreview("Created **Projects-CoS** as a **Project**")).toBe(
      "Created Projects-CoS as a Project",
    );
    const preview = completionNotificationPreview(`${"word ".repeat(50)}**end**`);
    expect(preview).toHaveLength(180);
    expect(preview).not.toContain("*");
    expect(preview.startsWith("word word")).toBe(true);
    expect(completionNotificationPreview("**  **")).toBe("");
  });
});

describe("secretAskNotification", () => {
  it("uses the generic answer title and a short, redacted label", () => {
    const notification = secretAskNotification(
      "Bot",
      `Sign in for fake-token-123 ${"word ".repeat(100)}`,
      ["fake-token-123"],
    );
    expect(notification.title).toBe("Bot needs an answer");
    expect(notification.body).toHaveLength(180);
    expect(notification.body.startsWith("Sign in for [redacted] word")).toBe(true);
  });

  it("redacts a Markdown-split protected value before the notification cut", () => {
    const body = secretAskNotification("Bot", `${"x".repeat(167)} fake-**token**-123`, [
      "fake-token-123",
    ]).body;
    expect(body).toBe(`${"x".repeat(167)} [redacted]`);
    expect(body).not.toContain("fake-");
  });

  it("keeps the body within 180 characters when redaction expands a value", () => {
    const body = secretAskNotification("Bot", `${"x".repeat(170)} ab**c1**23`, ["abc123"]).body;
    expect(body).toHaveLength(180);
    expect(body).not.toContain("abc");
  });

  it("does not let Markdown split a protected value past redaction", () => {
    expect(secretAskNotification("Bot", "Code fake-**token**-123", ["fake-token-123"]).body).toBe(
      "Code [redacted]",
    );
  });
});

describe("completionMarksUnread", () => {
  it("ignores silent routine activity but keeps routine comments and manual replies unread", () => {
    expect(completionMarksUnread("routine", "")).toBe(false);
    expect(completionMarksUnread("routine", "Daily report ready")).toBe(true);
    expect(completionMarksUnread("user", "")).toBe(true);
  });

  it("keeps peer completions quiet except the requester’s final answer", () => {
    expect(completionMarksUnread("bot_message", "The result")).toBe(false);
    expect(completionMarksUnread("bot_message", "The result", true)).toBe(true);
  });

  it("keeps empty-run done. fallback unread and notifying", () => {
    const segments = completionMessageSegments([]);
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([{ kind: "text", text: "done." }]);
    expect(text).toBe("done.");
    expect(completionMarksUnread("routine", text)).toBe(true);
    expect(completionMarksUnread("user", text)).toBe(true);
  });

  it("does not invent done. unread for a routine whose only activity is a completed subagent", () => {
    // Terminal subagent rows are published separately; skipEmptyFallback mirrors that durable
    // activity so completion does not synthesize "done." (which would mark unread + notify).
    const segments = completionMessageSegments([], { skipEmptyFallback: true });
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([]);
    expect(text).toBe("");
    expect(completionMarksUnread("routine", text)).toBe(false);
    expect(completionMarksUnread("user", text)).toBe(true);
  });

  it("lets a silent routine finish with no chat text, unread, or notify", () => {
    expect(runAllowsSilentEmpty("routine")).toBe(true);
    expect(runAllowsSilentEmpty("user")).toBe(false);
    const segments = completionMessageSegments([], {
      allowSilentEmpty: runAllowsSilentEmpty("routine"),
    });
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([]);
    expect(text).toBe("");
    expect(completionMarksUnread("routine", text)).toBe(false);
  });

  it("allows reaction silence without a bubble, fallback, or unread", () => {
    expect(runAllowsSilentEmpty("reaction")).toBe(true);
    const silent = stripNoResponseReply(NO_RESPONSE, [{ kind: "text", text: NO_RESPONSE }]);
    const segments = completionMessageSegments(silent.blocks, {
      allowSilentEmpty: runAllowsSilentEmpty("reaction"),
    });
    const blocks = finalBlocksAfterMidTurnProgress(segments, runAllowsSilentEmpty("reaction"));
    expect(blocks).toEqual([]);
    expect(
      completionMarksUnread("reaction", completionNotificationBody(silent.assembled, blocks)),
    ).toBe(false);
    expect(runReplyGuidance("reaction")).toBe(REACTION_SILENT_REPLY_GUIDANCE);
    expect(runReplyGuidance("reaction")).toContain(`exactly ${NO_RESPONSE}`);
    expect(runReplyGuidance("reaction")).not.toContain("routine's prompt");
    expect(runPromotesMidTurnNarration("reaction")).toBe(true);
  });

  it("publishes a real reaction reply normally", () => {
    const reply = stripNoResponseReply("I'll correct that.", [
      { kind: "text", text: "I'll correct that." },
    ]);
    const segments = completionMessageSegments(reply.blocks, {
      allowSilentEmpty: runAllowsSilentEmpty("reaction"),
    });
    expect(finalBlocksAfterMidTurnProgress(segments, true)).toEqual(reply.blocks);
    expect(
      completionMarksUnread("reaction", completionNotificationBody(reply.assembled, segments)),
    ).toBe(true);
  });

  it("still invents done. for a user-triggered empty run", () => {
    expect(runAllowsSilentEmpty("user")).toBe(false);
    const segments = completionMessageSegments([], {
      allowSilentEmpty: runAllowsSilentEmpty("user"),
    });
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([{ kind: "text", text: "done." }]);
    expect(completionMarksUnread("user", text)).toBe(true);
  });

  it.each(["routine", "reaction"])(
    "drops a tool-only %s final so silence leaves no chat bubble",
    (trigger) => {
      const steps = [{ kind: "steps" as const, steps: [{ label: "List items", count: 1 }] }];
      const segments = completionMessageSegments(steps, {
        allowSilentEmpty: runAllowsSilentEmpty(trigger),
      });
      const blocks = finalBlocksAfterMidTurnProgress(segments, runAllowsSilentEmpty(trigger));
      expect(segments).toEqual(steps);
      expect(blocks).toEqual([]);
      expect(completionMarksUnread(trigger, completionNotificationBody("", blocks))).toBe(false);
    },
  );
});

describe("background ticket runs", () => {
  it("stay silent, drop mid-turn narration, and never mark unread or notify", () => {
    expect(runAllowsSilentEmpty("tickets")).toBe(true);
    expect(runPromotesMidTurnNarration("tickets")).toBe(false);
    const segments = completionMessageSegments([{ kind: "text", text: "Closed the ticket." }], {
      allowSilentEmpty: runAllowsSilentEmpty("tickets"),
      suppressOutput: true,
    });
    expect(segments).toEqual([]);
    expect(completionMarksUnread("tickets", "")).toBe(false);
    expect(completionMarksUnread("tickets", "Closed the ticket.")).toBe(false);
    expect(subagentMarksUnread("tickets", "completed")).toBe(false);
    expect(subagentMarksUnread("tickets", "failed")).toBe(false);
    expect(runSendsFinishNotification("tickets")).toBe(false);
    expect(runSendsFinishNotification("user")).toBe(true);
    expect(runReplyGuidance("tickets")).toBe(TICKET_SILENT_REPLY_GUIDANCE);
    expect(runReplyGuidance("tickets")).toContain("ticket_comment");
  });

  it("sends no finish notice for a background helper; the turn passing on its result does", () => {
    expect(runSendsFinishNotification("helper")).toBe(false);
    expect(runSendsFinishNotification("helper_result")).toBe(true);
  });

  it("drops a tool-only ticket final so the transcript gets no bubble", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Ticket comment", count: 1 }] }];
    const blocks = finalBlocksAfterMidTurnProgress(steps, runAllowsSilentEmpty("tickets"));
    expect(blocks).toEqual([]);
  });
});

describe("stripNoResponseReply", () => {
  it("leaves an already-empty reply empty", () => {
    expect(stripNoResponseReply("", [])).toEqual({ assembled: "", blocks: [] });
  });

  it("treats an exact sentinel final as empty", () => {
    const stripped = stripNoResponseReply(NO_RESPONSE, [{ kind: "text", text: NO_RESPONSE }]);
    expect(stripped).toEqual({ assembled: "", blocks: [] });
    const text = completionNotificationBody(stripped.assembled, stripped.blocks);
    expect(text).toBe("");
    expect(completionMarksUnread("routine", text)).toBe(false);
  });

  it("treats a trimmed sentinel as empty", () => {
    const padded = `  ${NO_RESPONSE}  `;
    const stripped = stripNoResponseReply(padded, [{ kind: "text", text: padded }]);
    expect(stripped).toEqual({ assembled: "", blocks: [] });
  });

  it("treats the sentinel repeated across joined text segments as empty", () => {
    // Segments are joined without a separator, so a model that re-emits the
    // sentinel after each tool batch produces NO_RESPONSENO_RESPONSE.
    const blocks = [
      { kind: "text" as const, text: NO_RESPONSE },
      { kind: "text" as const, text: NO_RESPONSE },
      { kind: "text" as const, text: NO_RESPONSE },
    ];
    const stripped = stripNoResponseReply(NO_RESPONSE.repeat(3), blocks);
    expect(stripped).toEqual({ assembled: "", blocks: [] });
    expect(
      completionMarksUnread(
        "routine",
        completionNotificationBody(stripped.assembled, stripped.blocks),
      ),
    ).toBe(false);
  });

  it("treats the sentinel repeated with whitespace between as empty", () => {
    const spaced = `${NO_RESPONSE}\n${NO_RESPONSE} ${NO_RESPONSE}`;
    expect(stripNoResponseReply(spaced, [{ kind: "text", text: spaced }])).toEqual({
      assembled: "",
      blocks: [],
    });
  });

  it("keeps prose that merely repeats the sentinel between words", () => {
    const text = `first ${NO_RESPONSE} and ${NO_RESPONSE} last`;
    const blocks = [{ kind: "text" as const, text }];
    expect(stripNoResponseReply(text, blocks)).toEqual({ assembled: text, blocks });
  });

  it("keeps a reply with prose but drops a stray sentinel at its start", () => {
    const text = `${NO_RESPONSE} all clear`;
    const blocks = [{ kind: "text" as const, text }];
    const stripped = stripNoResponseReply(text, blocks);
    expect(stripped).toEqual({
      assembled: "all clear",
      blocks: [{ kind: "text", text: "all clear" }],
    });
    expect(completionMarksUnread("routine", stripped.assembled)).toBe(true);
  });

  it("drops a stray sentinel glued to the end of a report, keeping the report", () => {
    // Observed on a routine: the model wrote its report and then also emitted the silence
    // signal; segments are joined without a separator.
    const report =
      "**À surveiller** : UPS 2U, mémoire 96 %. Proposition : examiner sans modification.";
    const text = `${report}${NO_RESPONSE}`;
    const stripped = stripNoResponseReply(text, [
      { kind: "text", text: report },
      { kind: "text", text: NO_RESPONSE },
    ]);
    expect(stripped).toEqual({ assembled: report, blocks: [{ kind: "text", text: report }] });
    expect(completionNotificationBody(stripped.assembled, stripped.blocks)).not.toContain(
      NO_RESPONSE,
    );
    expect(completionMarksUnread("routine", stripped.assembled)).toBe(true);
  });

  it.each([
    ["report.NO_RESPONSENO_RESPONSE", "report."],
    ["NO_RESPONSENO_RESPONSE report", "report"],
    ["report.NO_RESPONSE NO_RESPONSE", "report."],
    ["NO_RESPONSE report", "report"],
    ["NO_RESPONSE.report", ".report"],
    ["NO_RESPONSE first NO_RESPONSE last NO_RESPONSE", "first NO_RESPONSE last"],
  ])("strips whole edge runs from %s while keeping prose unread", (text, prose) => {
    const stripped = stripNoResponseReply(text, [{ kind: "text", text }]);
    expect(stripped).toEqual({ assembled: prose, blocks: [{ kind: "text", text: prose }] });
    expect(completionNotificationBody(stripped.assembled, stripped.blocks)).toBe(prose);
    expect(completionMarksUnread("routine", prose)).toBe(true);
  });

  it.each([
    ["first ", NO_RESPONSE, " last"],
    ["first NO_RESPONSE last"],
    ["NO_RESPONSE_POLICY"],
    ["reportNO_RESPONSENO_RESPONSE"],
    ["NO_RESPONSENO_RESPONSE_POLICY"],
    ["NO_RES", "PONSE_POLICY"],
  ])("preserves interior sentinels and identifiers in joined blocks %j", (...parts) => {
    const text = parts.join("");
    const blocks = parts.map((part) => ({ kind: "text" as const, text: part }));
    expect(stripNoResponseReply(text, blocks)).toEqual({ assembled: text, blocks });
    expect(completionNotificationBody(text, blocks)).toBe(text);
  });

  it("applies only joined edge removals across text blocks and preserves sibling activity", () => {
    const steps = { kind: "steps" as const, steps: [{ label: "List items", count: 1 }] };
    const parts = [
      "NO_RES",
      "PONSENO_RESPONSE first ",
      NO_RESPONSE,
      " last.NO_RES",
      "PONSE NO_RESPONSE",
    ];
    const blocks = parts.map((text) => ({ kind: "text" as const, text }));
    const stripped = stripNoResponseReply(parts.join(""), [blocks[0]!, steps, ...blocks.slice(1)]);
    expect(stripped).toEqual({
      assembled: "first NO_RESPONSE last.",
      blocks: [
        steps,
        { kind: "text", text: "first " },
        { kind: "text", text: NO_RESPONSE },
        { kind: "text", text: " last." },
      ],
    });
  });

  it("uses joined text blocks when assembled text is empty", () => {
    const blocks = [
      { kind: "text" as const, text: "first " },
      { kind: "text" as const, text: NO_RESPONSE },
      { kind: "text" as const, text: " last.NO_RESPONSENO_RESPONSE" },
    ];
    const stripped = stripNoResponseReply("", blocks);
    expect(stripped).toEqual({
      assembled: "",
      blocks: [blocks[0], blocks[1], { kind: "text", text: " last." }],
    });
    expect(completionNotificationBody(stripped.assembled, stripped.blocks)).toBe(
      "first NO_RESPONSE last.",
    );
  });

  it("leaves long trailing whitespace alone when there is no edge sentinel", () => {
    const text = `report.${" ".repeat(100_000)}`;
    const blocks = [{ kind: "text" as const, text }];
    expect(stripNoResponseReply(text, blocks)).toEqual({ assembled: text, blocks });
  });

  it("drops a standalone leading sentinel but keeps the identifier that follows it", () => {
    const text = `${NO_RESPONSE} NO_RESPONSE_POLICY is enabled.`;
    const blocks = [{ kind: "text" as const, text }];
    expect(stripNoResponseReply(text, blocks)).toEqual({
      assembled: "NO_RESPONSE_POLICY is enabled.",
      blocks: [{ kind: "text", text: "NO_RESPONSE_POLICY is enabled." }],
    });
  });

  it("drops a standalone trailing sentinel but keeps the identifier before it", () => {
    const text = `see POLICY_NO_RESPONSE ${NO_RESPONSE}`;
    const blocks = [{ kind: "text" as const, text }];
    expect(stripNoResponseReply(text, blocks)).toEqual({
      assembled: "see POLICY_NO_RESPONSE",
      blocks: [{ kind: "text", text: "see POLICY_NO_RESPONSE" }],
    });
  });

  it("keeps a glued run that ends inside an identifier", () => {
    const text = `${NO_RESPONSE}NO_RESPONSE_POLICY is enabled.`;
    const blocks = [{ kind: "text" as const, text }];
    expect(stripNoResponseReply(text, blocks)).toEqual({ assembled: text, blocks });
  });

  it("leaves a word that merely contains the sentinel alone", () => {
    const text = `see NO_RESPONSE_POLICY`;
    const blocks = [{ kind: "text" as const, text }];
    expect(stripNoResponseReply(text, blocks)).toEqual({ assembled: text, blocks });
  });

  it("fails closed on case, punctuation, and wrapped variants", () => {
    expect(isExactNoResponse("no_response")).toBe(false);
    expect(isExactNoResponse("NO_RESPONSE.")).toBe(false);
    expect(isExactNoResponse(`\`${NO_RESPONSE}\``)).toBe(false);
    expect(stripNoResponseReply("no_response", [{ kind: "text", text: "no_response" }])).toEqual({
      assembled: "no_response",
      blocks: [{ kind: "text", text: "no_response" }],
    });
  });

  it("does not strip when assembled is the sentinel but a text block has extra prose", () => {
    const blocks = [{ kind: "text" as const, text: `${NO_RESPONSE} all clear` }];
    expect(stripNoResponseReply(NO_RESPONSE, blocks)).toEqual({
      assembled: NO_RESPONSE,
      blocks,
    });
  });

  it("strips a sentinel text block beside tool activity so the hollow final can drop", () => {
    const steps = { kind: "steps" as const, steps: [{ label: "List items", count: 1 }] };
    const stripped = stripNoResponseReply(NO_RESPONSE, [
      steps,
      { kind: "text", text: NO_RESPONSE },
    ]);
    expect(stripped).toEqual({ assembled: "", blocks: [steps] });
    const blocks = finalBlocksAfterMidTurnProgress(
      stripped.blocks,
      runAllowsSilentEmpty("routine"),
    );
    expect(blocks).toEqual([]);
    expect(completionMarksUnread("routine", completionNotificationBody("", blocks))).toBe(false);
  });
});

describe("runReplyGuidance", () => {
  it("does not ask routine runs for message_user progress", () => {
    expect(runPromotesMidTurnNarration("routine")).toBe(false);
    expect(runReplyGuidance("routine")).toBe(ROUTINE_SILENT_REPLY_GUIDANCE);
    expect(runReplyGuidance("routine")).not.toContain("progress updates with message_user");
    expect(runReplyGuidance("routine")).toContain(NO_RESPONSE);
    expect(runReplyGuidance("routine")).toContain(`exactly ${NO_RESPONSE}`);
    expect(runReplyGuidance("routine")).not.toContain("Leave the final reply empty");
  });

  it("gives the creation intro the profile fields its prompt asks about", () => {
    const bot = {
      name: "Ada",
      description: "Reads and sorts mail.",
      instructions: "Never send mail without asking.",
    };
    const intro = runIdentityInstruction(bot, "created");
    expect(intro).toContain("Description: Reads and sorts mail.");
    expect(intro).toContain("Never send mail without asking.");
    expect(runIdentityInstruction({ ...bot, instructions: "" }, "created")).toContain(
      "Instructions: (none)",
    );
    expect(runIdentityInstruction(bot, "user")).toContain(bot.instructions);
  });

  it("keeps the public description and private instructions distinct on normal runs", () => {
    const bot = {
      name: "Ada",
      description: "Reads and sorts mail.",
      instructions: "Never send mail without asking.",
    };
    const prompt = runIdentityInstruction(bot, "user");
    expect(prompt).toContain("Ada\nReads and sorts mail.");
    expect(prompt).toContain("Teammates see only the profile above.");
    expect(prompt.endsWith("Never send mail without asking.")).toBe(true);
  });

  it("does not repeat text that older bots saved as both fields", () => {
    const bot = {
      name: "Ada",
      description: "Reads and sorts mail.",
      instructions: "Reads and sorts mail.",
    };
    expect(runIdentityInstruction(bot, "user")).toBe("Ada\nReads and sorts mail.");
    expect(runIdentityInstruction({ ...bot, instructions: "" }, "user")).toBe(
      "Ada\nReads and sorts mail.",
    );
  });

  it("omits blank profile lines and treats missing fields as empty", () => {
    expect(
      runIdentityInstruction({ name: "Ada", description: "", instructions: "Stay quiet." }, "user"),
    ).toBe(
      "Ada\nTeammates see only the profile above. These instructions are private to you:\nStay quiet.",
    );
    expect(runIdentityInstruction({ name: "Ada", description: "", instructions: "" }, "user")).toBe(
      "Ada",
    );
    expect(
      runIdentityInstruction(
        { name: "Ada", description: "Reads and sorts mail.", instructions: "" },
        "user",
      ),
    ).toBe("Ada\nReads and sorts mail.");
    expect(runIdentityInstruction({ name: "Ada" }, "routine")).toBe("Ada");
  });

  it("does not send a finish notification for the creation intro", () => {
    expect(runSendsFinishNotification("created")).toBe(false);
    expect(runSendsFinishNotification("user")).toBe(true);
    expect(runSendsFinishNotification("routine")).toBe(true);
  });

  it("opens the model stream only for the current running lease", () => {
    const owned = { status: "running", leaseOwner: "worker-1", leaseFence: 3 };
    expect(mayOpenModelStream(owned, "worker-1", 3, false)).toBe(true);
    expect(mayOpenModelStream(owned, "worker-2", 3, false)).toBe(false);
    expect(mayOpenModelStream(owned, "worker-1", 4, false)).toBe(false);
    expect(mayOpenModelStream({ ...owned, status: "cancelled" }, "worker-1", 3, false)).toBe(false);
    expect(mayOpenModelStream(owned, "worker-1", 3, true)).toBe(false);
    expect(mayOpenModelStream(null, "worker-1", 3, false)).toBe(false);
  });

  it("keeps progress guidance for user-triggered runs", () => {
    expect(runPromotesMidTurnNarration("user")).toBe(true);
    expect(runPromotesMidTurnNarration("messaging")).toBe(true);
    expect(runReplyGuidance("user")).toBe(longWorkProgressGuidance());
    expect(runReplyGuidance("user")).toContain("message_user");
    expect(runReplyGuidance("messaging")).toBe(longWorkProgressGuidance());
  });
});

describe("runReplyMode", () => {
  it("uses messages mode only on runs a person waits on, while message_user is offered", () => {
    expect(runReplyMode("user", "messages")).toBe("messages");
    expect(runReplyMode("messaging", "messages")).toBe("messages");
    expect(runReplyMode("user", "chat")).toBe("chat");
    for (const trigger of ["routine", "reaction", "bot_message", "tickets", "created", "webhook"])
      expect(runReplyMode(trigger, "messages")).toBe("chat");
    expect(runReplyMode("user", "messages", new Set(["message_user"]))).toBe("chat");
  });

  it("keeps a background helper in chat mode, since it cannot message the person", () => {
    expect(runReplyMode("helper", "messages")).toBe("chat");
    expect(runReplyMode("helper_result", "messages")).toBe("messages");
  });

  it("gives each mode its own guidance", () => {
    expect(runReplyGuidance("user", "chat")).toBe(longWorkProgressGuidance());
    expect(runReplyGuidance("user", "messages")).toBe(messagesModeReplyGuidance());
    expect(messagesModeReplyGuidance()).toContain("private and never shown");
    expect(messagesModeReplyGuidance()).toContain("message_user");
  });
});

describe("runPromotesMidTurnNarration", () => {
  it("drops mid-turn narration in bot-to-bot runs", () => {
    expect(runPromotesMidTurnNarration("bot_message")).toBe(false);
  });
});

describe("subagentMarksUnread", () => {
  it("ignores completed routine activity but preserves failures and manual activity", () => {
    expect(subagentMarksUnread("routine", "completed")).toBe(false);
    expect(subagentMarksUnread("routine", "failed")).toBe(true);
    expect(subagentMarksUnread("user", "completed")).toBe(true);
    expect(subagentMarksUnread("bot_message", "completed")).toBe(false);
    expect(subagentMarksUnread("bot_message", "failed")).toBe(true);
    expect(subagentMarksUnread("bot_message", "completed", true)).toBe(true);
  });
});

describe("stripStrayNoResponse for runs that must reply", () => {
  it.each([
    ["Done.\n\nNO_RESPONSE", "Done."],
    ["Done.NO_RESPONSENO_RESPONSE", "Done."],
    ["NO_RESPONSE Done.", "Done."],
  ])("drops edge sentinels from %j", (text, prose) => {
    expect(stripStrayNoResponse(text, [{ kind: "text", text }])).toEqual({
      assembled: prose,
      blocks: [{ kind: "text", text: prose }],
    });
  });

  it.each([
    [NO_RESPONSE],
    [`  ${NO_RESPONSE}NO_RESPONSE  `],
    ["first NO_RESPONSE last"],
    ["reportNO_RESPONSE"],
    ["NO_RESPONSE_POLICY is on."],
    [""],
  ])("leaves %j unchanged", (text) => {
    const blocks = text ? [{ kind: "text" as const, text }] : [];
    expect(stripStrayNoResponse(text, blocks)).toEqual({ assembled: text, blocks });
  });
});

describe("isNoResponseReply", () => {
  it("is true only for the sentinel alone, not for an empty or prose reply", () => {
    expect(isNoResponseReply(NO_RESPONSE, [])).toBe(true);
    expect(isNoResponseReply("", [{ kind: "text", text: NO_RESPONSE }])).toBe(true);
    expect(isNoResponseReply("", [])).toBe(false);
    expect(isNoResponseReply("Sure, here you go.", [])).toBe(false);
    expect(isNoResponseReply(NO_RESPONSE, [{ kind: "text", text: "Sure, here you go." }])).toBe(
      false,
    );
  });
});

describe("couldBecomeNoResponse", () => {
  it("holds text that is, or may still grow into, the sentinel", () => {
    for (const text of ["", "N", "NO_", "NO_RESPON", NO_RESPONSE, "NO_RESPONSE NO_RES"]) {
      expect(couldBecomeNoResponse(text)).toBe(true);
    }
  });

  it("lets real text through", () => {
    for (const text of ["Sure", "No, I can't", "NO_RESPONSE_POLICY", "NO_RESPONSE Sure"]) {
      expect(couldBecomeNoResponse(text)).toBe(false);
    }
  });
});

describe("isPlaceholderReply", () => {
  it("is true for whitespace, invisible characters and a lone dot or ellipsis", () => {
    for (const text of [".", "...", "…", "\u200c", "\u200b\u200c", " \n", "\ufeff", "\u200c."]) {
      expect(isPlaceholderReply(text, [])).toBe(true);
    }
    expect(isPlaceholderReply("", [{ kind: "text", text: "\u200c" }])).toBe(true);
  });

  it("is false for empty text and for any real mark, letter, digit or emoji", () => {
    expect(isPlaceholderReply("", [])).toBe(false);
    for (const text of ["Paris", "ok", "7", "👍", "été", "好", "✓", "—", "-", "?", ". ok"]) {
      expect(isPlaceholderReply(text, [])).toBe(false);
    }
  });
});

describe("handoffEndedTurn", () => {
  const missing = new ModelOutputError(MISSING_TOOL_FINAL_RESPONSE_ERROR);

  it("ends a handed-off turn that wrote no final answer without failing it", () => {
    expect(handoffEndedTurn({ handedOff: true }, missing)).toBe(true);
  });

  it("still fails a turn that did not hand off, or failed for another reason", () => {
    expect(handoffEndedTurn({ handedOff: false }, missing)).toBe(false);
    expect(handoffEndedTurn({ handedOff: true }, new ModelOutputError("cut off"))).toBe(false);
    expect(
      handoffEndedTurn({ handedOff: true }, new Error(MISSING_TOOL_FINAL_RESPONSE_ERROR)),
    ).toBe(false);
  });
});
