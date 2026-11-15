import { describe, expect, it } from "vitest";

import {
  appendConnectorIntent,
  buildComposerMentionOptions,
  connectorIntentLine,
  filterComposerMentionTargets,
  mentionChipKey,
  mentionConnectorsFrom,
  partitionComposerMentions,
  resolveComposerSendPlan,
  routineScheduleSubtitle,
  splitMentionText,
  stripMentionKinds,
  stripMentionToken,
  toThreadMentionPayload,
} from "./composer-mentions.js";

describe("buildComposerMentionOptions", () => {
  it("lists bots groups routines connectors and everyone", () => {
    const options = buildComposerMentionOptions({
      query: "",
      includeEveryone: true,
      bots: [{ id: "b1", name: "Chief", color: "#111" }],
      groups: [{ id: "g1", name: "Planning" }],
      routines: [
        { id: "r1", name: "Daily digest", crons: ["0 9 * * 1-5"], botId: "b1", botName: "Chief" },
      ],
      connectors: [
        { id: "c1", name: "Gmail", authStatus: "connected", connectionId: "c1" },
        { id: "catalog:stripe", name: "Stripe", authStatus: "needs_auth" },
      ],
    });
    expect(options.map((option) => option.kind)).toEqual([
      "everyone",
      "bot",
      "group",
      "routine",
      "connector",
      "connector",
    ]);
    expect(options.find((option) => option.kind === "bot")?.subtitle).toBe("Bot");
    expect(options.find((option) => option.name === "Gmail")?.subtitle).toBe("Connected");
    expect(options.find((option) => option.name === "Stripe")?.subtitle).toBe("Needs auth");
    expect(options.find((option) => option.kind === "routine")?.subtitle).toMatch(/Weekdays/i);
  });

  it("disambiguates same-name routines with bot name", () => {
    const options = buildComposerMentionOptions({
      query: "daily",
      bots: [],
      groups: [],
      routines: [
        { id: "r1", name: "Daily", crons: ["0 9 * * *"], botId: "b1", botName: "Chief" },
        { id: "r2", name: "Daily", crons: ["0 10 * * *"], botId: "b2", botName: "Writer" },
      ],
      connectors: [],
    });
    expect(options).toHaveLength(2);
    expect(options[0]?.subtitle).toContain("Chief");
    expect(options[1]?.subtitle).toContain("Writer");
    expect(mentionChipKey(options[0]!)).toBe("routine:r1");
    expect(mentionChipKey(options[1]!)).toBe("routine:r2");
  });

  it("skips the current group", () => {
    const options = buildComposerMentionOptions({
      query: "",
      currentGroupId: "g1",
      bots: [],
      groups: [
        { id: "g1", name: "Here" },
        { id: "g2", name: "Elsewhere" },
      ],
      routines: [],
      connectors: [],
    });
    expect(options.map((option) => option.id)).toEqual(["g2"]);
  });

  it("filters by query before applying limit so later kinds stay reachable", () => {
    const bots = Array.from({ length: 40 }, (_, index) => ({
      id: `b${index}`,
      name: `Bot${index}`,
    }));
    const options = buildComposerMentionOptions({
      query: "gmail",
      bots,
      groups: [],
      routines: [],
      connectors: [
        { id: "c1", name: "Gmail", authStatus: "connected", connectionId: "c1" },
        { id: "c2", name: "Granola", authStatus: "needs_auth" },
      ],
      limit: 10,
    });
    expect(options.map((option) => option.name)).toEqual(["Gmail"]);
  });

  it("returns the full catalog when limit is omitted", () => {
    const bots = Array.from({ length: 80 }, (_, index) => ({
      id: `b${index}`,
      name: `Bot${index}`,
    }));
    const options = buildComposerMentionOptions({
      query: "",
      bots,
      groups: [],
      routines: [],
      connectors: [{ id: "c1", name: "Gmail", authStatus: "connected", connectionId: "c1" }],
    });
    expect(options).toHaveLength(81);
    expect(options.at(-1)?.name).toBe("Gmail");
  });
});

describe("resolveComposerSendPlan", () => {
  it("opens a chip-only @Group from a 1:1 without sending", () => {
    const plan = resolveComposerSendPlan({
      text: "@Planning",
      mentions: [{ kind: "group", id: "g1", name: "Planning" }],
      hasAttachments: false,
    });
    expect(plan.isNoOp).toBe(false);
    expect(plan.shouldSend).toBe(false);
    expect(plan.shouldOpenGroup).toBe(true);
    expect(plan.rerouteGroupId).toBe("g1");
    expect(plan.trimmed).toBe("");
  });

  it("sends leftover text into the mentioned group", () => {
    const plan = resolveComposerSendPlan({
      text: "@Planning follow up",
      mentions: [{ kind: "group", id: "g1", name: "Planning" }],
      hasAttachments: false,
    });
    expect(plan.shouldSend).toBe(true);
    expect(plan.shouldOpenGroup).toBe(true);
    expect(plan.trimmed).toBe("follow up");
  });

  it("runs routines then opens the group when both chips have no text", () => {
    const plan = resolveComposerSendPlan({
      text: "@Planning @Digest",
      mentions: [
        { kind: "group", id: "g1", name: "Planning" },
        { kind: "routine", id: "r1", name: "Digest" },
      ],
      hasAttachments: false,
    });
    expect(plan.shouldRunRoutines).toBe(true);
    expect(plan.routineIds).toEqual(["r1"]);
    expect(plan.shouldOpenGroup).toBe(true);
    expect(plan.shouldSend).toBe(false);
    expect(plan.isNoOp).toBe(false);
  });

  it("opens another group from inside a group thread", () => {
    const plan = resolveComposerSendPlan({
      text: "@Other",
      mentions: [{ kind: "group", id: "g2", name: "Other" }],
      hasAttachments: false,
    });
    expect(plan.shouldOpenGroup).toBe(true);
    expect(plan.rerouteGroupId).toBe("g2");
    expect(plan.shouldSend).toBe(false);
    expect(plan.isNoOp).toBe(false);
  });
});

describe("partition and payload", () => {
  it("partitions typed mentions", () => {
    const parts = partitionComposerMentions([
      { kind: "bot", id: "b1", name: "Chief" },
      { kind: "group", id: "g1", name: "Planning" },
      { kind: "routine", id: "r1", name: "Digest" },
      { kind: "connector", id: "c1", name: "Gmail", authStatus: "connected", connectionId: "c1" },
      { kind: "everyone", id: "everyone", name: "everyone" },
    ]);
    expect(parts.bots).toHaveLength(1);
    expect(parts.groups).toHaveLength(1);
    expect(parts.routines).toHaveLength(1);
    expect(parts.connectors).toHaveLength(1);
    expect(parts.everyone).toBe(true);
  });

  it("omits needs-auth catalog connectors from API payload", () => {
    expect(
      toThreadMentionPayload([
        { kind: "bot", id: "b1", name: "Chief" },
        {
          kind: "connector",
          id: "catalog:stripe",
          name: "Stripe",
          authStatus: "needs_auth",
        },
        {
          kind: "connector",
          id: "c1",
          name: "Gmail",
          authStatus: "connected",
          connectionId: "c1",
        },
      ]),
    ).toEqual([
      { kind: "bot", id: "b1" },
      { kind: "connector", id: "c1" },
    ]);
  });
});

describe("strip and connector intent", () => {
  it("strips selected mention kinds from prompt text", () => {
    expect(
      stripMentionKinds(
        "@Planning @Chief check this",
        [
          { kind: "group", name: "Planning" },
          { kind: "bot", name: "Chief" },
        ],
        ["group"],
      ),
    ).toBe("@Chief check this");
  });

  it("strips multi-word mention tokens", () => {
    expect(stripMentionToken("Ask @Draft team please", "Draft team")).toBe("Ask please");
  });

  it("preserves newlines when stripping mention tokens", () => {
    expect(stripMentionToken("@Planning\n\nline two", "Planning")).toBe("line two");
    expect(stripMentionToken("one\n@Planning\ntwo", "Planning")).toBe("one\n\ntwo");
  });

  it("builds connector intent lines", () => {
    expect(connectorIntentLine(["Gmail", "Stripe"])).toBe(
      "Use these connectors if relevant: Gmail, Stripe.",
    );
    expect(appendConnectorIntent("check inbox", ["Gmail"])).toBe(
      "check inbox\n\nUse these connectors if relevant: Gmail.",
    );
    expect(appendConnectorIntent("", ["Gmail"])).toBe("Use these connectors if relevant: Gmail.");
  });

  it("formats routine subtitles", () => {
    expect(routineScheduleSubtitle(["0 9 * * 1-5"])).toMatch(/Weekdays/i);
    expect(routineScheduleSubtitle(["0 9 * * 1-5"], "Chief")).toContain("Chief");
  });
});

it("searches the readable fallback when a mention name is opaque", () => {
  expect(
    buildComposerMentionOptions({
      query: "bot",
      bots: [{ id: "bot-1", name: "__TestTok1__" }],
      groups: [],
      routines: [],
      connectors: [],
    }),
  ).toEqual([{ kind: "bot", id: "bot-1", name: "Bot", subtitle: "Bot", color: undefined }]);
});

describe("mentionConnectorsFrom", () => {
  it("lists connected apps, then catalog apps not yet covered by a connection", () => {
    const catalogItem = { connected: false, noAuth: false };
    expect(
      mentionConnectorsFrom(
        [
          { id: "c1", displayName: "Gmail", provider: "gmail", status: "connected" },
          { id: "c2", displayName: "Notion", provider: "notion", status: "revoked" },
        ],
        [
          { ...catalogItem, connectorId: "k", slug: "GMAIL", name: "Google Mail" },
          { ...catalogItem, connectorId: "k", slug: "gmail-work", name: "gmail" },
          { ...catalogItem, connectorId: "k", slug: "notion", name: "Notion" },
          { ...catalogItem, connectorId: "k", slug: "slack", name: "Slack", connected: true },
          { ...catalogItem, connectorId: "k", slug: "weather", name: "Weather", noAuth: true },
        ],
      ),
    ).toEqual([
      { id: "c1", name: "Gmail", authStatus: "connected", connectionId: "c1" },
      { id: "catalog:k:notion", name: "Notion", authStatus: "needs_auth" },
    ]);
  });
});

describe("filterComposerMentionTargets", () => {
  const everyone = { kind: "everyone", name: "everyone" } as const;
  const targets = [
    everyone,
    { kind: "bot", name: "Research Bot" },
    { kind: "bot", name: "Chef" },
    { kind: "bot", name: "Robot Arm" },
    { kind: "bot", name: "Zoë Rivera" },
  ] as const;
  const names = (query: string) => filterComposerMentionTargets(targets, query).map((t) => t.name);

  it("keeps the given order for an empty query", () => {
    expect(names("  ")).toEqual(targets.map((target) => target.name));
  });

  it("ranks a word that starts a name word above one inside it, ties in given order", () => {
    expect(names("bo")).toEqual(["Research Bot", "Robot Arm"]);
    expect(names("ro")).toEqual(["Robot Arm"]);
  });

  it("requires every word and ignores accents and case", () => {
    expect(names("research bo")).toEqual(["Research Bot"]);
    expect(names("zoe")).toEqual(["Zoë Rivera"]);
    expect(names("chef bot")).toEqual([]);
  });

  it("answers to all and everyone for the everyone row only", () => {
    expect(names("al")).toEqual(["everyone"]);
    expect(names("every")).toEqual(["everyone"]);
  });
});

describe("splitMentionText", () => {
  const targets = [{ name: "Ada" }, { name: "Ada Lovelace" }, { name: "everyone" }];

  it("cuts out each known @Name, longest name first, and keeps the rest as plain runs", () => {
    expect(splitMentionText("hi @Ada Lovelace and @ada, @everyone!", targets)).toEqual([
      { text: "hi " },
      { text: "@Ada Lovelace", target: targets[1] },
      { text: " and " },
      { text: "@ada", target: targets[0] },
      { text: ", " },
      { text: "@everyone", target: targets[2] },
      { text: "!" },
    ]);
  });

  it("leaves text without a known name, an email address and a longer word alone", () => {
    expect(splitMentionText("mail ada@example.test or @Adam", targets)).toEqual([
      { text: "mail ada@example.test or @Adam" },
    ]);
  });
});
