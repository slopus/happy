import { describe, expect, it } from "vitest";
import {
  hasMentionToken,
  inferHandoffTargetBotId,
  inferHandoffTargetName,
  memberName,
  mentionedGroupBotIds,
  resolveGroupTargetBotIds,
} from "./group-mentions.js";

const members = [
  { id: "a", name: "BotA" },
  { id: "b", name: "BotB" },
  { id: "c", name: "Writer" },
];

describe("hasMentionToken", () => {
  it("requires a boundary after the complete member name", () => {
    expect(hasMentionToken("Ask @Ann to review", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Ann, then continue", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Anna to review", "Ann")).toBe(false);
    expect(hasMentionToken("name@Ann", "Ann")).toBe(false);
    expect(hasMentionToken("contact@everyone", "everyone")).toBe(false);
  });

  it("supports multi-word and Unicode member names", () => {
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Research Writer")).toBe(true);
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Éditeur")).toBe(true);
  });
});

describe("resolveGroupTargetBotIds", () => {
  it("returns mentioned bots from text", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@BotA gather sources. @BotB summarize.",
        members,
      }),
    ).toEqual(["a", "b"]);
  });

  it("returns all members for @everyone", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@everyone please review",
        members,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("merges explicit mentions", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b"],
      }),
    ).toEqual(["b"]);
  });

  it.each([undefined, ["review"]])(
    "prefers the complete multi-word name with explicit mentions %j",
    (explicitMentions) => {
      expect(
        resolveGroupTargetBotIds({
          text: "@Design Review please review",
          members: [
            { id: "design", name: "Design" },
            { id: "review", name: "Design Review" },
          ],
          explicitMentions,
        }),
      ).toEqual(["review"]);
    },
  );

  it.each([undefined, ["helper"]])(
    "does not broadcast a longer member name with explicit mentions %j",
    (explicitMentions) => {
      expect(
        resolveGroupTargetBotIds({
          text: "@EVERYONE Helper please review",
          members: [...members, { id: "helper", name: "Everyone Helper" }],
          explicitMentions,
        }),
      ).toEqual(["helper"]);
    },
  );

  it.each(["@Design and @Design Review", "@Design Review and @Design"])(
    "keeps separately written prefix mentions in %s",
    (text) => {
      expect(
        resolveGroupTargetBotIds({
          text,
          members: [
            { id: "design", name: "Design" },
            { id: "review", name: "Design Review" },
          ],
        }),
      ).toEqual(["design", "review"]);
    },
  );

  it("keeps an explicit prefix bot alongside a longer text mention", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@Design Review please review",
        members: [
          { id: "design", name: "Design" },
          { id: "review", name: "Design Review" },
        ],
        explicitMentions: ["design"],
      }),
    ).toEqual(["design", "review"]);
  });

  it.each(["@Everyone Helper and @everyone", "@everyone and @Everyone Helper"])(
    "keeps an actual broadcast in %s",
    (text) => {
      const roster = [...members, { id: "helper", name: "Everyone Helper" }];
      expect(resolveGroupTargetBotIds({ text, members: roster })).toEqual([
        "a",
        "b",
        "c",
        "helper",
      ]);
    },
  );

  it("matches literal punctuation and Unicode names without overlapping prefixes", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "(@design.review), @ÉQUIPE (UX) and @ſupport team.",
        members: [
          { id: "default", name: "Default" },
          { id: "design", name: "Design" },
          { id: "review", name: "Design.Review" },
          { id: "equipe", name: "Équipe" },
          { id: "ux", name: " Équipe (UX) " },
          { id: "support", name: "Support Team" },
        ],
      }),
    ).toEqual(["review", "ux", "support"]);
  });

  it("keeps all members with the same complete name", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@Design Review",
        members: [
          { id: "design", name: "Design" },
          { id: "review1", name: " Design Review " },
          { id: "review2", name: "design review" },
          { id: "blank", name: " " },
        ],
      }),
    ).toEqual(["review1", "review2"]);
  });

  it.each([
    ["@Équipe (UX)@Writer please review", ["ux", "writer"]],
    ["@Équipe (UX)@everyone please review", ["default", "ux", "writer"]],
  ])("keeps adjacent mentions in %s", (text, expected) => {
    expect(
      resolveGroupTargetBotIds({
        text,
        members: [
          { id: "default", name: "Default" },
          { id: "ux", name: "Équipe (UX)" },
          { id: "writer", name: "Writer" },
        ],
      }),
    ).toEqual(expected);
  });

  it("preserves reserved everyone precedence over an identically named member", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@everyone",
        members: [...members, { id: "everyone", name: "Everyone" }],
      }),
    ).toEqual(["a", "b", "c", "everyone"]);
  });

  it("ignores embedded and incomplete tokens before reaching everyone", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "contact@everyone name@Writer @Writer-more @Writer2",
        members,
      }),
    ).toEqual(["a", "b", "c"]);
    expect(resolveGroupTargetBotIds({ text: "@everyone", members: [] })).toEqual([]);
  });

  it("matches multi-word and Unicode names without prefix collisions", () => {
    const namedMembers = [
      { id: "research", name: "Research Writer" },
      { id: "edit", name: "Éditeur" },
      { id: "ann", name: "Ann" },
      { id: "anna", name: "Anna" },
    ];
    expect(
      resolveGroupTargetBotIds({
        text: "@Research Writer compare this with @Éditeur and @Anna.",
        members: namedMembers,
      }),
    ).toEqual(["research", "edit", "anna"]);
  });

  it("ignores explicit mentions for bots that are not group members", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b", "outsider"],
      }),
    ).toEqual(["b"]);
  });

  it("reaches every member when unmentioned", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello team",
        members,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("reaches every member when only a non-member is mentioned", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello @Outsider",
        members,
        explicitMentions: ["outsider"],
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("reaches only the mentioned members, not the rest", () => {
    expect(resolveGroupTargetBotIds({ text: "@BotB what do you think?", members })).toEqual(["b"]);
    expect(
      resolveGroupTargetBotIds({
        text: "what do you think?",
        members,
        explicitMentions: ["c"],
      }),
    ).toEqual(["c"]);
  });
});

describe("mentionedGroupBotIds", () => {
  it("is empty when the message names nobody", () => {
    expect(mentionedGroupBotIds({ text: "hello team", members })).toEqual([]);
  });

  it("names the members a message addresses", () => {
    expect(mentionedGroupBotIds({ text: "@BotA and @Writer", members })).toEqual(["a", "c"]);
    expect(mentionedGroupBotIds({ text: "@everyone", members })).toEqual(["a", "b", "c"]);
  });
});

describe("inferHandoffTargetName", () => {
  it("picks Writer when BotA is also mentioned", () => {
    expect(inferHandoffTargetName("@BotA hand this to Writer for the draft")).toBe("Writer");
  });
});

describe("inferHandoffTargetBotId", () => {
  it("recognizes hand this to Writer", () => {
    expect(inferHandoffTargetBotId("hand this to Writer for the draft", members)).toBe("c");
  });

  it("recognizes @Writer take the draft", () => {
    expect(inferHandoffTargetBotId("@Writer take the draft", members)).toBe("c");
  });

  it("resolves Writer from mixed mention prompt", () => {
    expect(inferHandoffTargetBotId("@BotA hand this to Writer for the draft", members)).toBe("c");
  });

  it("resolves multi-word handoff targets", () => {
    expect(
      inferHandoffTargetBotId("hand this to Research Writer for the draft", [
        ...members,
        { id: "research", name: "Research Writer" },
      ]),
    ).toBe("research");
  });
});

describe("memberName", () => {
  it("finds a member's roster name by bot id", () => {
    const members = [{ botId: "b1", name: "Chief" }];
    expect(memberName(members, "b1")).toBe("Chief");
    expect(memberName(members, "b2")).toBeUndefined();
    expect(memberName(members, undefined)).toBeUndefined();
    expect(memberName(undefined, "b1")).toBeUndefined();
  });
});
