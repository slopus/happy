import { describe, expect, it } from "vitest";
import type { ActionApprovalRule, ApprovalMode } from "./action-approval.js";
import {
  applyJudgeDecision,
  approvalModeFromPreference,
  approvalPreferenceFromMode,
  approvalRuleApplies,
  approvalRuleChoices,
  approvalRuleEffectChoices,
  batchActions,
  connectorKindFromToolName,
  connectorReadRequiresApproval,
  connectorToolRequiresApproval,
  decisiveActionApprovalRules,
  isApprovalAskBlock,
  isOwnerStartedRun,
  isSecretAskBlock,
  memoryWriteNeedsApproval,
  newSiteOutcome,
  outboundSiteGate,
  outsideRunToolRequiresApproval,
  planActionGate,
  receiptItems,
  repeatsDeniedAction,
  resolveActionApproval,
  resolveActionApprovalDetail,
  resolveActionApprovalForTools,
  toolRequiresApproval,
  toolRequiresExplicitApproval,
  toolResultTaintsRun,
  watchToolRefusal,
} from "./action-approval.js";

describe("toolRequiresApproval", () => {
  it.each([
    { effect: "deny" as const, decision: "deny" },
    { effect: "require_approval" as const, decision: "ask" },
    { effect: "always_allow" as const, decision: "allow" },
  ])("keeps original and scoped tool rules effective: $effect", ({ effect, decision }) => {
    const tool = { name: "mail_send_email", aliases: ["mail_send_email__account"] };
    for (const matchValue of [tool.name, tool.aliases[0]!]) {
      expect(
        resolveActionApprovalForTools({
          tools: [tool],
          rules: [{ effect, matchKind: "tool", matchValue }],
        }).decision,
      ).toBe(decision);
    }
    expect(
      resolveActionApprovalForTools({
        tools: [tool],
        rules: [
          { effect: "always_allow", matchKind: "tool", matchValue: tool.aliases[0]! },
          { effect: "deny", matchKind: "tool", matchValue: tool.name },
        ],
      }).decision,
    ).toBe("deny");
  });

  it("requires approval for consequential builtins and connector writes", () => {
    expect(toolRequiresApproval("destination.write", true)).toBe(true);
    expect(toolRequiresApproval("secret_request", false)).toBe(true);
    expect(toolRequiresApproval("forget_secret", false)).toBe(true);
    expect(toolRequiresApproval("forget_memory", false)).toBe(true);
    expect(toolRequiresApproval("list_secrets", false)).toBe(false);
    // A random value the bot cannot read exposes nothing, and never replaces a saved credential.
    expect(toolRequiresApproval("generate_secret", false)).toBe(false);
    expect(toolRequiresApproval("delete_bot", false)).toBe(false);
    expect(toolRequiresApproval("delete_bot", true, true)).toBe(true);
    expect(toolRequiresApproval("delete_bot", true, false)).toBe(true);
    expect(toolRequiresApproval("archive_bot", false)).toBe(true);
    expect(toolRequiresApproval("cloud_agent_launch", false)).toBe(true);
    expect(toolRequiresApproval("create_space", false)).toBe(true);
    expect(toolRequiresExplicitApproval("create_space")).toBe(true);
    // The wallet owner approves every purchase on the provider's side.
    expect(toolRequiresApproval("request_purchase", false)).toBe(false);
    expect(toolRequiresApproval("purchase_status", false)).toBe(false);
    expect(toolRequiresExplicitApproval("save_shared_memory")).toBe(false);
    expect(toolRequiresExplicitApproval("archive_bot")).toBe(false);
  });

  it("does not gate read-only or local work", () => {
    for (const name of [
      "list_files",
      "computer_observe",
      "read_file",
      "write_file",
      "shell",
      "remember",
      "save_shared_memory",
      "spawn_bot",
      "run_subagent",
    ]) {
      expect(toolRequiresApproval(name, false)).toBe(false);
    }
  });

  it("always asks before bot management writes that cost money or rewrite a bot", () => {
    for (const name of ["set_child_instructions", "set_child_bot_model"]) {
      expect(toolRequiresApproval(name, false)).toBe(true);
      expect(toolRequiresExplicitApproval(name)).toBe(true);
    }
  });

  it("treats grouping and scheduling other bots as ordinary approvals that Never ask skips", () => {
    for (const name of ["create_group", "update_group", "create_child_routine"]) {
      expect(toolRequiresApproval(name, false)).toBe(true);
      expect(toolRequiresExplicitApproval(name)).toBe(false);
    }
  });

  it("never asks before reading the bots it manages or organizing the sidebar", () => {
    for (const name of ["list_fleet", "organize_bot", "update_bot"]) {
      expect(toolRequiresApproval(name, false)).toBe(false);
      expect(toolRequiresExplicitApproval(name)).toBe(false);
    }
    expect(toolRequiresApproval("organize_bot", true)).toBe(false);
  });

  it("gates connector executes except obvious reads", () => {
    expect(toolRequiresApproval("gmail_send_email", true)).toBe(true);
    expect(toolRequiresApproval("crm_create_note", true)).toBe(true);
    expect(toolRequiresApproval("get_contact", true)).toBe(false);
    expect(toolRequiresApproval("contacts_get", true)).toBe(false);
    expect(toolRequiresApproval("GMAIL_LIST_THREADS", true)).toBe(false);
    expect(toolRequiresApproval("list_messages", true)).toBe(false);
    expect(toolRequiresApproval("search_threads", true)).toBe(false);
    expect(toolRequiresApproval("find_user", true)).toBe(false);
    expect(toolRequiresApproval("read_inbox", true)).toBe(false);
    expect(toolRequiresApproval("contacts_get_or_create", true)).toBe(true);
    expect(toolRequiresApproval("notion_search_and_update", true)).toBe(true);
    expect(toolRequiresApproval("crm_get_then_upsert", true)).toBe(true);
    expect(toolRequiresApproval("github_get_and_lock_issue", true)).toBe(true);
  });
});

describe("connectorToolRequiresApproval", () => {
  it("matches read-only connector tool names", () => {
    expect(connectorToolRequiresApproval("list_items")).toBe(false);
    expect(connectorToolRequiresApproval("send_message")).toBe(true);
  });

  it("reads words separated by hyphens", () => {
    expect(connectorToolRequiresApproval("gmail-find-email", true)).toBe(false);
    expect(connectorToolRequiresApproval("google_calendar-list-events", true)).toBe(false);
    expect(connectorToolRequiresApproval("gmail-send-email", true)).toBe(true);
    expect(connectorToolRequiresApproval("google_sheets-get-or-create-row", true)).toBe(true);
    expect(connectorToolRequiresApproval("hubspot-find-and-update-contact", true)).toBe(true);
  });

  it("requires approval for a declared write whatever its name says", () => {
    expect(connectorToolRequiresApproval("read_profile_card", false)).toBe(true);
    expect(connectorToolRequiresApproval("find_validator_record", false)).toBe(true);
    expect(connectorToolRequiresApproval("read_profile_card", true)).toBe(false);
    expect(connectorToolRequiresApproval("read_profile_card")).toBe(false);
  });

  it("never lets a declared read relax a mutating or ambiguous name", () => {
    expect(connectorToolRequiresApproval("delete_item", true)).toBe(true);
    expect(connectorToolRequiresApproval("get_or_create_contact", true)).toBe(true);
    expect(connectorToolRequiresApproval("profile_card", true)).toBe(true);
  });

  it("still requires approval for a declared read whose name says load", () => {
    expect(connectorToolRequiresApproval("warehouse-load-rows", true)).toBe(true);
  });
});

describe("resolveActionApprovalDetail", () => {
  it("applies category rules to declared writes with read-looking names", () => {
    const rules = [
      { effect: "require_approval" as const, matchKind: "category" as const, matchValue: "email" },
    ];
    const base = { toolName: "gmail_read_thread", connectorKind: "gmail", rules };
    expect(resolveActionApprovalDetail(base).decision).toBe("allow");
    expect(resolveActionApprovalDetail({ ...base, readOnly: false }).decision).toBe("ask");
  });

  it("pipedream-connector-rule", () => {
    const deny = (matchValue: string) => [
      { effect: "deny" as const, matchKind: "connector" as const, matchValue },
    ];
    expect(
      resolveActionApprovalDetail({
        toolName: "gmail-delete-email",
        readOnly: false,
        rules: deny("gmail"),
      }).decision,
    ).toBe("deny");
    expect(
      resolveActionApprovalDetail({
        toolName: "google_calendar-delete-event",
        readOnly: false,
        rules: deny("google_calendar"),
      }).decision,
    ).toBe("deny");
    expect(
      resolveActionApprovalDetail({
        toolName: "gmail-delete-email",
        readOnly: false,
        rules: [{ effect: "require_approval", matchKind: "category", matchValue: "email" }],
      }).decision,
    ).toBe("ask");
  });
});

describe("isOwnerStartedRun", () => {
  it.each([
    ["user", false, true],
    ["call_end", false, true],
    ["follow_up", true, true],
    ["follow_up", false, false],
    ["bot_message", true, false],
    ["messaging", true, false],
    ["spawn", true, false],
    ["tickets", true, false],
    ["webhook", true, false],
    ["routine", true, false],
    ["resume", true, false],
    ["unknown", true, false],
  ])("treats %s (follow-up from user: %s) as owner-started: %s", (trigger, fromUser, expected) => {
    expect(isOwnerStartedRun(trigger, fromUser)).toBe(expected);
  });
});

it("gates built-ins that change something only in runs outside text started", () => {
  for (const name of ["shell", "write_file", "computer_act", "remember", "render_plot"]) {
    expect(outsideRunToolRequiresApproval("webhook", name)).toBe(true);
    expect(outsideRunToolRequiresApproval("user", name)).toBe(false);
  }
  expect(outsideRunToolRequiresApproval("webhook", "save_shared_memory")).toBe(true);
  expect(outsideRunToolRequiresApproval("webhook", "add_mcp_server")).toBe(true);
  for (const name of ["read_file", "computer_observe", "message_user", "ask_user"]) {
    expect(outsideRunToolRequiresApproval("webhook", name)).toBe(false);
  }
});

it("treats a declared write with a read-looking name as a write", () => {
  for (const name of ["read_profile_card", "find_validator_record", "get_status"]) {
    expect(toolRequiresApproval(name, true, false)).toBe(true);
  }
});

describe("isApprovalAskBlock", () => {
  it("detects allow/deny approval cards", () => {
    expect(
      isApprovalAskBlock({
        kind: "ask",
        approvalEffectId: "effect-1",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "always", label: "Always allow" },
          { id: "deny", label: "Deny" },
        ],
      }),
    ).toBe(true);
    expect(isApprovalAskBlock({ kind: "ask" })).toBe(false);
    expect(
      isApprovalAskBlock({
        kind: "ask",
        approvalEffectId: "effect-1",
        actions: [{ id: "deny", label: "No" }],
      }),
    ).toBe(false);
    for (const ids of [["allow"], ["allow", "deny", "edit"]]) {
      expect(
        isApprovalAskBlock({
          kind: "ask",
          approvalEffectId: "effect-1",
          actions: ids.map((id) => ({ id, label: id })),
        }),
      ).toBe(false);
    }
  });
});

describe("isSecretAskBlock", () => {
  it("detects masked secret asks", () => {
    expect(isSecretAskBlock({ kind: "ask", input: "secret" })).toBe(true);
    expect(isSecretAskBlock({ kind: "ask", input: "text" })).toBe(false);
    expect(
      isSecretAskBlock({
        kind: "ask",
        input: "secret",
        approvalEffectId: "effect-1",
      }),
    ).toBe(false);
  });
});

describe("connectorKindFromToolName", () => {
  it("uses the first underscore segment", () => {
    expect(connectorKindFromToolName("gmail_send_email")).toBe("gmail");
  });

  it("prefers the longest matching connected provider slug", () => {
    expect(
      connectorKindFromToolName("microsoft_outlook_send_email", ["microsoft", "microsoft_outlook"]),
    ).toBe("microsoft_outlook");
  });

  it("matches a known kind before a hyphen and keeps the longest slug", () => {
    const kinds = ["gmail", "google_calendar", "github"];
    expect(connectorKindFromToolName("gmail-find-email", kinds)).toBe("gmail");
    expect(connectorKindFromToolName("gmail-delete-email", kinds)).toBe("gmail");
    expect(connectorKindFromToolName("gmail-bulk-archive-emails", kinds)).toBe("gmail");
    expect(connectorKindFromToolName("google_calendar-list-events", kinds)).toBe("google_calendar");
    expect(connectorKindFromToolName("google_calendar-delete-event", kinds)).toBe(
      "google_calendar",
    );
    expect(connectorKindFromToolName("gmail_send_email", kinds)).toBe("gmail");
    expect(
      connectorKindFromToolName("microsoft_outlook_send_email", ["microsoft", "microsoft_outlook"]),
    ).toBe("microsoft_outlook");
  });

  it("reads a plain slug before the first hyphen when no kind is known", () => {
    expect(connectorKindFromToolName("gmail-find-email")).toBe("gmail");
    expect(connectorKindFromToolName("google_calendar-list-events")).toBe("google_calendar");
    expect(connectorKindFromToolName("gmail_send_email")).toBe("gmail");
    expect(connectorKindFromToolName("COMPOSIO_MULTI_EXECUTE_TOOL")).toBe("composio");
    expect(connectorKindFromToolName("mcp__server__tool")).toBe("mcp");
    expect(connectorKindFromToolName("mcp__server-tool")).toBe("mcp");
  });
});

describe("resolveActionApproval", () => {
  const alwaysAllowDestination: ActionApprovalRule[] = [
    { effect: "always_allow", matchKind: "tool", matchValue: "destination.write" },
  ];
  const requireEmail: ActionApprovalRule[] = [
    { effect: "require_approval", matchKind: "category", matchValue: "email" },
  ];
  const requireDestination: ActionApprovalRule[] = [
    { effect: "require_approval", matchKind: "tool", matchValue: "destination.write" },
  ];

  it("skips approval when always-allow matches", () => {
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: alwaysAllowDestination,
      }),
    ).toBe("allow");
  });

  it("requires approval for email even when always-allow would match another tool", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_send_email",
        rules: [...alwaysAllowDestination, ...requireEmail],
      }),
    ).toBe("ask");
  });

  it("does not apply consequential categories to connector reads", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_list_threads",
        rules: requireEmail,
      }),
    ).toBe("allow");
  });

  it("lets an explicit rule gate a tool that is exempt by default", () => {
    expect(
      resolveActionApproval({
        toolName: "shell",
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "shell" }],
      }),
    ).toBe("ask");
  });

  it("lets require_approval beat always-allow at the same specificity", () => {
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: [...alwaysAllowDestination, ...requireDestination],
      }),
    ).toBe("ask");
  });

  it("allows actions by default when no rules match", () => {
    expect(
      resolveActionApproval({
        toolName: "list_files",
        rules: [],
      }),
    ).toBe("allow");
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: [],
      }),
    ).toBe("allow");
  });

  it("lets a tool exception override a broader category rule", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_send_email",
        rules: [
          ...requireEmail,
          { effect: "always_allow", matchKind: "tool", matchValue: "gmail_send_email" },
        ],
      }),
    ).toBe("allow");
  });

  it("labels always-allow vs default allow", () => {
    expect(
      resolveActionApprovalDetail({
        toolName: "destination.write",
        rules: alwaysAllowDestination,
      }),
    ).toMatchObject({ decision: "allow", source: "always_allow" });
    expect(
      resolveActionApprovalDetail({
        toolName: "destination.write",
        rules: [],
      }),
    ).toMatchObject({ decision: "allow", source: "default" });
  });
});

describe("planActionGate", () => {
  const unruled = {
    decision: "allow" as const,
    source: "default" as const,
    matchingRules: [],
    decisiveRules: [],
  };
  const allowed = {
    decision: "allow" as const,
    source: "always_allow" as const,
    matchingRules: [],
    decisiveRules: [],
  };
  const asked = {
    decision: "ask" as const,
    source: "require_approval" as const,
    matchingRules: [],
    decisiveRules: [],
  };
  const blocked = {
    decision: "deny" as const,
    source: "deny" as const,
    matchingRules: [],
    decisiveRules: [],
  };
  const gate = (
    mode: ApprovalMode,
    overrides: Partial<Parameters<typeof planActionGate>[0]> = {},
  ) =>
    planActionGate({
      resolved: unruled,
      mode,
      consequential: true,
      checkerConfigured: true,
      ...overrides,
    });

  it("runs an unlisted change in Never ask, judges it in Auto and asks in Ask", () => {
    expect(gate("never")).toBe("allow");
    expect(gate("auto")).toBe("judge");
    expect(gate("ask")).toBe("ask");
  });

  it("asks in Auto when no approval model is set up", () => {
    expect(gate("auto", { checkerConfigured: false })).toBe("ask");
  });

  it("runs an allowlisted change in every mode without judging", () => {
    for (const mode of ["never", "auto", "ask"] as const) {
      expect(gate(mode, { resolved: allowed })).toBe("allow");
    }
  });

  it("refuses a blocked action in every mode, even one a person must approve", () => {
    for (const mode of ["never", "auto", "ask"] as const) {
      expect(gate(mode, { resolved: blocked })).toBe("deny");
      expect(gate(mode, { resolved: blocked, mandatory: true })).toBe("deny");
      expect(gate(mode, { resolved: blocked, consequential: false })).toBe("deny");
    }
  });

  it("asks for a purchase in every mode, past an allow rule, and still refuses a block", () => {
    for (const mode of ["never", "auto", "ask"] as const) {
      expect(gate(mode, { purchase: true, consequential: false })).toBe("ask");
      expect(gate(mode, { purchase: true, resolved: allowed })).toBe("ask");
      expect(gate(mode, { purchase: true, mandatory: true, steerable: true })).toBe("ask");
      expect(gate(mode, { purchase: true, resolved: blocked })).toBe("deny");
    }
  });

  it("runs reads in every mode", () => {
    for (const mode of ["never", "auto", "ask"] as const) {
      expect(gate(mode, { consequential: false })).toBe("allow");
    }
  });

  it("keeps an older ask rule asking, except in Never ask, which never waits", () => {
    expect(gate("never", { resolved: asked })).toBe("allow");
    expect(gate("auto", { resolved: asked })).toBe("ask");
    expect(gate("ask", { resolved: asked })).toBe("ask");
  });

  it("asks a person for an approval nothing else may give, in Auto and Ask", () => {
    expect(gate("auto", { mandatory: true, resolved: allowed })).toBe("ask");
    expect(gate("ask", { mandatory: true, resolved: allowed })).toBe("ask");
  });

  it("in Never ask runs it for the owner's own run and refuses it when outside text could steer it", () => {
    expect(gate("never", { mandatory: true, steerable: false })).toBe("allow");
    expect(gate("never", { mandatory: true, steerable: true })).toBe("deny");
  });

  it("only lets the approval model check a read outside content may have chosen", () => {
    const read = { consequential: false, reviewOnly: true };
    expect(gate("auto", read)).toBe("judge");
    expect(gate("auto", { ...read, checkerConfigured: false })).toBe("allow");
    expect(gate("ask", read)).toBe("allow");
    expect(gate("never", read)).toBe("allow");
  });

  it("judges a new site in Auto even with a rule for the whole tool, and asks in Ask", () => {
    expect(gate("auto", { resolved: allowed, newDestination: true })).toBe("judge");
    expect(gate("auto", { newDestination: true, checkerConfigured: false })).toBe("ask");
    expect(gate("ask", { resolved: allowed, newDestination: true })).toBe("ask");
    expect(gate("never", { newDestination: true })).toBe("allow");
  });
});

describe("approval modes from stored preferences", () => {
  it("maps both ways", () => {
    for (const mode of ["never", "auto", "ask"] as const) {
      expect(approvalModeFromPreference(approvalPreferenceFromMode(mode))).toBe(mode);
    }
    expect(approvalModeFromPreference({ enabled: true, skipApprovals: true })).toBe("never");
    expect(approvalModeFromPreference({ enabled: false, skipApprovals: false })).toBe("ask");
  });
});

describe("block rules", () => {
  const rule = (
    effect: ActionApprovalRule["effect"],
    matchKind: ActionApprovalRule["matchKind"],
    matchValue: string,
  ): ActionApprovalRule => ({ effect, matchKind, matchValue });

  it("wins over a narrower allow", () => {
    expect(
      resolveActionApprovalDetail({
        toolName: "GMAIL_SEND_EMAIL",
        connectorKind: "gmail",
        rules: [
          rule("deny", "connector", "gmail"),
          rule("always_allow", "tool", "gmail_send_email"),
        ],
      }),
    ).toMatchObject({ decision: "deny", source: "deny" });
  });

  it("blocks Composio's code tools, which can call any action, unless it is for a site", () => {
    const resolve = (deny: ActionApprovalRule) =>
      resolveActionApprovalDetail({
        toolName: "COMPOSIO_REMOTE_WORKBENCH",
        rules: [deny],
      }).decision;
    expect(resolve(rule("deny", "tool", "GMAIL_SEND_EMAIL"))).toBe("deny");
    expect(resolve(rule("deny", "site", "example.com"))).toBe("allow");
    expect(
      resolveActionApprovalDetail({
        toolName: "COMPOSIO_REMOTE_WORKBENCH",
        rules: [rule("always_allow", "tool", "GMAIL_SEND_EMAIL")],
      }),
    ).toMatchObject({ decision: "allow", source: "default" });
  });

  it("refuses a blocked tool in a change watch", () => {
    expect(
      watchToolRefusal({
        toolName: "gmail_list_messages",
        readOnly: true,
        rules: [rule("deny", "tool", "gmail_list_messages")],
      }),
    ).toContain("blocked");
  });
});

describe("decisiveActionApprovalRules", () => {
  const rule = (
    effect: ActionApprovalRule["effect"],
    matchKind: ActionApprovalRule["matchKind"],
    matchValue: string,
  ): ActionApprovalRule => ({ effect, matchKind, matchValue });

  it("reports only the most specific rule that asked", () => {
    const category = rule("require_approval", "category", "email");
    const tool = rule("require_approval", "tool", "gmail_send_email");
    const connector = rule("always_allow", "connector", "gmail");
    const resolved = resolveActionApprovalDetail({
      toolName: "GMAIL_SEND_EMAIL",
      connectorKind: "gmail",
      rules: [category, tool, connector],
    });

    expect(resolved).toMatchObject({ decision: "ask", source: "require_approval" });
    expect(decisiveActionApprovalRules(resolved)).toEqual([tool]);
  });

  it("reports the block rule even when a narrower allow also matched", () => {
    const block = rule("deny", "connector", "gmail");
    const allow = rule("always_allow", "tool", "gmail_send_email");
    const resolved = resolveActionApprovalDetail({
      toolName: "GMAIL_SEND_EMAIL",
      connectorKind: "gmail",
      rules: [block, allow],
    });

    expect(resolved).toMatchObject({ decision: "deny", source: "deny" });
    expect(decisiveActionApprovalRules(resolved)).toEqual([block]);
  });

  it("reports nothing when no saved rule decided", () => {
    expect(
      decisiveActionApprovalRules(
        resolveActionApprovalDetail({
          toolName: "GMAIL_SEND_EMAIL",
          connectorKind: "gmail",
          rules: [],
        }),
      ),
    ).toEqual([]);
    expect(
      decisiveActionApprovalRules(
        resolveActionApprovalDetail({
          toolName: "GMAIL_SEND_EMAIL",
          connectorKind: "gmail",
          rules: [rule("always_allow", "tool", "gmail_send_email")],
        }),
      ),
    ).toEqual([]);
  });
});

const BATCH_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

describe("batches", () => {
  const shape = { items: "tools", action: "tool_slug" };

  it("lists each action a batch runs, and flags an entry that names none", () => {
    expect(
      batchActions(shape, {
        tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }, { tool_slug: "GMAIL_SEND_EMAIL" }],
      }),
    ).toEqual({ actions: ["GMAIL_SEND_EMAIL"], complete: true });
    expect(
      batchActions(shape, {
        tools: [{ tool_slug: "SLACK_SEND_MESSAGE" }, { arguments: {} }],
      }),
    ).toEqual({ actions: ["SLACK_SEND_MESSAGE"], complete: false });
    expect(batchActions(shape, { tools: [{ tool_slug: "  " }] })).toEqual({
      actions: [],
      complete: false,
    });
  });

  it("treats a batch that lists no actions as unreadable", () => {
    for (const args of [{ tools: [] }, {}, { tools: "GMAIL_SEND_EMAIL" }, null]) {
      expect(batchActions(shape, args)).toEqual({ actions: [], complete: false });
    }
  });

  const rules: ActionApprovalRule[] = [
    { effect: "always_allow", matchKind: "tool", matchValue: "GMAIL_SEND_EMAIL" },
    { effect: "deny", matchKind: "tool", matchValue: "HUBSPOT_DELETE_CONTACT" },
  ];

  it("allows a batch by rule only when every action is allowed", () => {
    expect(
      resolveActionApprovalForTools({ tools: [{ name: "GMAIL_SEND_EMAIL" }], rules }),
    ).toMatchObject({ decision: "allow", source: "always_allow" });
    expect(
      resolveActionApprovalForTools({
        tools: [{ name: "GMAIL_SEND_EMAIL" }, { name: "SLACK_SEND_MESSAGE" }],
        rules,
      }),
    ).toMatchObject({ decision: "allow", source: "default" });
  });

  it("blocks the whole batch when one action, the batch tool or its connector is blocked", () => {
    expect(
      resolveActionApprovalForTools({
        tools: [{ name: "GMAIL_SEND_EMAIL" }, { name: "HUBSPOT_DELETE_CONTACT" }],
        rules,
      }).decision,
    ).toBe("deny");
    expect(
      resolveActionApprovalForTools({
        tools: [{ name: "GMAIL_SEND_EMAIL" }],
        wrapper: { name: BATCH_TOOL, connectorKind: "composio" },
        rules: [...rules, { effect: "deny", matchKind: "connector", matchValue: "composio" }],
      }).decision,
    ).toBe("deny");
  });

  it("does not carry an always-allowed archive over to a send in the same batch tool", () => {
    const archived: ActionApprovalRule[] = [
      { effect: "always_allow", matchKind: "tool", matchValue: "gmail_archive_thread" },
    ];
    expect(
      resolveActionApprovalForTools({ tools: [{ name: "GMAIL_ARCHIVE_THREAD" }], rules: archived }),
    ).toMatchObject({ decision: "allow", source: "always_allow" });
    expect(
      resolveActionApprovalForTools({ tools: [{ name: "GMAIL_SEND_EMAIL" }], rules: archived }),
    ).toMatchObject({ decision: "allow", source: "default" });
  });

  it("lets the strictest action decide a mixed batch", () => {
    const mixed: ActionApprovalRule[] = [
      { effect: "always_allow", matchKind: "tool", matchValue: "GMAIL_ARCHIVE_THREAD" },
      { effect: "require_approval", matchKind: "tool", matchValue: "GMAIL_SEND_EMAIL" },
      { effect: "deny", matchKind: "tool", matchValue: "GMAIL_DELETE_MESSAGE" },
    ];
    const resolve = (...names: string[]) =>
      resolveActionApprovalForTools({ tools: names.map((name) => ({ name })), rules: mixed });
    expect(resolve("GMAIL_ARCHIVE_THREAD", "GMAIL_SEND_EMAIL")).toMatchObject({
      decision: "ask",
      source: "require_approval",
    });
    expect(
      resolve("GMAIL_SEND_EMAIL", "GMAIL_ARCHIVE_THREAD", "GMAIL_DELETE_MESSAGE").decision,
    ).toBe("deny");
    expect(resolve("GMAIL_ARCHIVE_THREAD", "GMAIL_LIST_THREADS")).toMatchObject({
      decision: "allow",
      source: "default",
    });
    expect(resolve()).toMatchObject({ decision: "allow", source: "default" });
  });

  it("matches a tool or category rule on the action inside the batch", () => {
    const tool = (name: string) => ({ name, connectorKind: connectorKindFromToolName(name) });
    expect(
      resolveActionApprovalForTools({
        tools: [tool("GMAIL_SEND_EMAIL")],
        wrapper: { name: BATCH_TOOL, connectorKind: "composio" },
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "GMAIL_SEND_EMAIL" }],
      }).decision,
    ).toBe("ask");
    const email: ActionApprovalRule[] = [
      { effect: "require_approval", matchKind: "category", matchValue: "email" },
    ];
    expect(
      resolveActionApprovalForTools({
        tools: [tool("GMAIL_SEND_EMAIL")],
        wrapper: { name: BATCH_TOOL, connectorKind: "composio" },
        rules: email,
      }).decision,
    ).toBe("ask");
    expect(
      resolveActionApprovalForTools({
        tools: [tool("GMAIL_LIST_THREADS")],
        wrapper: { name: BATCH_TOOL, connectorKind: "composio" },
        rules: email,
      }).decision,
    ).toBe("allow");
  });

  it("never lets an allow rule on the batch tool allow its actions", () => {
    expect(
      resolveActionApprovalForTools({
        tools: [{ name: "SLACK_SEND_MESSAGE" }],
        wrapper: { name: BATCH_TOOL },
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: BATCH_TOOL }],
      }),
    ).toMatchObject({ decision: "allow", source: "default" });
  });

  it("attributes a batch ask only to the action whose rule required it", () => {
    const gmailAsk: ActionApprovalRule = {
      effect: "require_approval",
      matchKind: "connector",
      matchValue: "gmail",
    };
    const gmailAllow: ActionApprovalRule = {
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "GMAIL_SEND_EMAIL",
    };
    const purchaseAsk: ActionApprovalRule = {
      effect: "require_approval",
      matchKind: "category",
      matchValue: "purchase",
    };

    const resolved = resolveActionApprovalForTools({
      tools: [
        { name: "GMAIL_SEND_EMAIL", readOnly: false },
        { name: "STRIPE_CREATE_CHARGE", connectorKind: "stripe", readOnly: false },
      ],
      rules: [gmailAsk, gmailAllow, purchaseAsk],
    });

    expect(resolved).toMatchObject({ decision: "ask", source: "require_approval" });
    expect(resolved.matchingRules).toEqual(expect.arrayContaining([gmailAsk, purchaseAsk]));
    expect(decisiveActionApprovalRules(resolved)).toEqual([purchaseAsk]);
  });
});

describe("applyJudgeDecision", () => {
  it("maps pass and ask", () => {
    expect(applyJudgeDecision({ decision: "pass", consequential: true })).toBe("allow");
    expect(applyJudgeDecision({ decision: "ask", consequential: true })).toBe("ask");
  });

  it("fails closed on consequential checker errors and open on exempt", () => {
    expect(applyJudgeDecision({ decision: "error", consequential: true })).toBe("ask");
    expect(applyJudgeDecision({ decision: "error", consequential: false })).toBe("allow");
  });
});

describe("newSiteOutcome", () => {
  it("allows a new site Auto Review passed, in any run", () => {
    for (const trigger of ["user", "routine", "webhook"]) {
      expect(newSiteOutcome({ trigger, decision: "allow" })).toBe("allow");
    }
  });

  it("asks a person about a new site that was not passed", () => {
    for (const trigger of ["user", "follow_up", "routine", "messaging"]) {
      expect(newSiteOutcome({ trigger, decision: "ask" })).toBe("ask");
    }
  });

  it("refuses it in a webhook run, which has nobody to ask", () => {
    expect(newSiteOutcome({ trigger: "webhook", decision: "ask" })).toBe("deny");
  });
});

describe("watchToolRefusal", () => {
  const rule = (matchKind: string, matchValue: string, effect = "require_approval") =>
    ({ effect, matchKind, matchValue }) as Parameters<typeof watchToolRefusal>[0]["rules"][number];

  it("allows only explicitly declared reads", () => {
    expect(watchToolRefusal({ toolName: "drive_files", readOnly: true, rules: [] })).toBeNull();
  });

  it.each(["brain_changed", "gmail_search_threads", "clickbot_tasks", "send_email"])(
    "refuses missing metadata even for %s",
    (toolName) => {
      expect(watchToolRefusal({ toolName, rules: [] })).toMatch(/can change data/);
      expect(watchToolRefusal({ toolName, readOnly: false, rules: [] })).toMatch(/can change data/);
    },
  );

  it("refuses a read the space's rules would ask about", () => {
    expect(
      watchToolRefusal({
        toolName: "brain_search",
        readOnly: true,
        rules: [rule("tool", "brain_search")],
      }),
    ).toMatch(/approval/);
    expect(
      watchToolRefusal({
        toolName: "brain_search",
        readOnly: true,
        rules: [rule("tool", "brain_search", "always_allow")],
      }),
    ).toBeNull();
  });
});

describe("outboundSiteGate", () => {
  const siteRule: ActionApprovalRule = {
    effect: "always_allow",
    matchKind: "site",
    matchValue: "example.com",
  };

  it("lets a run reach sites it was given", () => {
    expect(outboundSiteGate({ site: "example.com", trusted: true, rules: [] })).toBe("allow");
  });

  it("marks any other site new, even with a rule for the whole tool", () => {
    expect(outboundSiteGate({ site: "attacker.test", trusted: false, rules: [] })).toBe("new");
    expect(
      outboundSiteGate({
        site: "attacker.test",
        trusted: false,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "web_fetch" }],
      }),
    ).toBe("new");
  });

  it("allows a site the owner always allowed, and only that site", () => {
    expect(outboundSiteGate({ site: "example.com", trusted: false, rules: [siteRule] })).toBe(
      "allow",
    );
    expect(outboundSiteGate({ site: "other.com", trusted: false, rules: [siteRule] })).toBe("new");
    expect(
      outboundSiteGate({
        site: "example.com",
        trusted: false,
        rules: [{ ...siteRule, effect: "require_approval" }],
      }),
    ).toBe("new");
    expect(
      outboundSiteGate({
        site: "example.com",
        trusted: false,
        rules: [{ ...siteRule, matchValue: "Example.COM" }],
      }),
    ).toBe("allow");
  });

  it("matches site rules ahead of tool rules", () => {
    expect(
      resolveActionApprovalDetail({
        toolName: "web_fetch",
        site: "example.com",
        rules: [
          { effect: "require_approval", matchKind: "tool", matchValue: "web_fetch" },
          siteRule,
        ],
      }).decision,
    ).toBe("allow");
    expect(
      resolveActionApprovalDetail({ toolName: "web_fetch", site: "other.com", rules: [siteRule] })
        .source,
    ).toBe("default");
  });
});

describe("connectorReadRequiresApproval", () => {
  it("keeps reads free until outside content enters the run", () => {
    expect(connectorReadRequiresApproval({ tainted: false, connectorTrusted: false })).toBe(false);
  });

  it("keeps reads free on a connector the run already used or was approved for", () => {
    expect(connectorReadRequiresApproval({ tainted: true, connectorTrusted: true })).toBe(false);
  });

  it("asks before a read on a new connector once the run is tainted", () => {
    expect(connectorReadRequiresApproval({ tainted: true, connectorTrusted: false })).toBe(true);
  });
});

describe("memoryWriteNeedsApproval", () => {
  const readOutside = async () => true;
  const readNothing = async () => false;

  it.each(["remember", "save_memory", "save_shared_memory"])(
    "gates %s only once outside content entered the run",
    async (name) => {
      await expect(memoryWriteNeedsApproval(name, readOutside)).resolves.toBe(true);
      await expect(memoryWriteNeedsApproval(name, readNothing)).resolves.toBe(false);
    },
  );

  it("leaves other tools alone and does not check the run for them", async () => {
    let checked = false;
    const check = async () => {
      checked = true;
      return true;
    };
    for (const name of ["recall_memory", "forget_memory", "write_file", "send_email"]) {
      await expect(memoryWriteNeedsApproval(name, check)).resolves.toBe(false);
    }
    expect(checked).toBe(false);
  });
});

describe("toolResultTaintsRun", () => {
  it("treats outside content as taint, including connector tools and new tools", () => {
    for (const tool of [
      "web_fetch",
      "web_search",
      "browser_snapshot",
      "computer_observe",
      "shell",
      "read_file",
      "run_subagent",
      "gmail_list_messages",
      "some_future_tool",
    ]) {
      expect(toolResultTaintsRun(tool)).toBe(true);
    }
  });

  it("does not taint on the bot's own writes and saved state", () => {
    for (const tool of ["ask_user", "remember", "recall_memory", "skill_read", "write_file"]) {
      expect(toolResultTaintsRun(tool)).toBe(false);
    }
  });
});

it("classifies schedule_update like schedule_create", () => {
  for (const name of ["schedule_create", "schedule_update"]) {
    expect(toolRequiresApproval(name, false)).toBe(false);
    expect(toolRequiresExplicitApproval(name)).toBe(false);
    expect(toolResultTaintsRun(name)).toBe(false);
  }
});

it("requires human confirmation to approve an agent connection", () => {
  expect(toolRequiresExplicitApproval("respond_agent_connection")).toBe(true);
  expect(toolRequiresApproval("respond_agent_connection", false)).toBe(true);
});

describe("repeatsDeniedAction", () => {
  const WRAPPER = "COMPOSIO_MULTI_EXECUTE_TOOL";
  const sent = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] };

  it("matches a plain tool whatever its arguments", () => {
    expect(
      repeatsDeniedAction({
        toolName: "shell",
        args: { command: "pwd" },
        denied: [{ command: "ls" }],
      }),
    ).toBe(true);
    expect(repeatsDeniedAction({ toolName: "shell", args: {}, denied: [] })).toBe(false);
  });

  it("matches a multi-execute on any shared slug, ignoring case", () => {
    const args = (...slugs: string[]) => ({ tools: slugs.map((tool_slug) => ({ tool_slug })) });
    expect(
      repeatsDeniedAction({
        toolName: WRAPPER,
        args: args("GMAIL_LIST", "gmail_send_email"),
        denied: [sent],
      }),
    ).toBe(true);
    expect(
      repeatsDeniedAction({ toolName: WRAPPER, args: args("GMAIL_SEND_DRAFT"), denied: [sent] }),
    ).toBe(false);
    expect(repeatsDeniedAction({ toolName: WRAPPER, args: {}, denied: [sent] })).toBe(false);
  });
});

describe("receiptItems", () => {
  it("leaves out page lines named like the card's own rows, in the app's words", () => {
    const items = [
      { name: "Bananas", amount: "$3.00" },
      { name: " gesamt ", amount: "$1.00" },
      { name: "Gesamt: fällig", amount: "$1.00" },
      { name: "Gesamtpaket Socken", amount: "$9.00" },
      { name: "Auf der Schaltfläche", amount: "$1.00" },
    ];
    expect(receiptItems(items, ["Gesamt", "Auf der Schaltfläche"])).toEqual([
      { name: "Bananas", amount: "$3.00" },
      { name: "Gesamtpaket Socken", amount: "$9.00" },
    ]);
  });
});

describe("approvalRuleChoices", () => {
  it("lists built-in tools by name and skips any that has a rule", () => {
    const choices = approvalRuleChoices([
      { effect: "require_approval", matchKind: "tool", matchValue: "Web_Search" },
      { effect: "deny", matchKind: "connector", matchValue: "shell" },
    ]);
    expect(choices).toContainEqual({ matchKind: "tool", matchValue: "shell", label: "Shell" });
    expect(choices.some((choice) => choice.matchValue === "web_search")).toBe(false);
    // Always approved by a person, but still worth blocking.
    expect(choices.some((choice) => choice.matchValue === "create_space")).toBe(true);
    const labels = choices.map((choice) => choice.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });
});

describe("approvalRuleApplies", () => {
  it("keeps only blocks in Never ask and every rule otherwise", () => {
    expect(approvalRuleApplies("never", "deny")).toBe(true);
    expect(approvalRuleApplies("never", "require_approval")).toBe(false);
    expect(approvalRuleApplies("never", "always_allow")).toBe(false);
    expect(approvalRuleApplies("ask", "always_allow")).toBe(true);
    expect(approvalRuleApplies(null, "require_approval")).toBe(true);
  });
});

describe("approvalRuleEffectChoices", () => {
  it("never offers Allow for a tool a person approves every time", () => {
    const rule = (matchKind: "tool" | "category", matchValue: string) => ({
      effect: "require_approval" as const,
      matchKind,
      matchValue,
    });
    expect(approvalRuleEffectChoices(rule("tool", "create_space"))).toEqual([
      "require_approval",
      "deny",
    ]);
    expect(approvalRuleEffectChoices(rule("tool", "shell"))).toEqual([
      "always_allow",
      "require_approval",
      "deny",
    ]);
    expect(approvalRuleEffectChoices(rule("category", "email"))).toEqual([]);
  });
});
