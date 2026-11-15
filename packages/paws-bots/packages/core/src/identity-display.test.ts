import { describe, expect, it } from "vitest";
import { projectMessages } from "./events.js";
import { displayIdentityEvent, displayIdentityResult } from "./identity-display.js";
import { identitySource } from "./identity-source.js";

const labels = {
  bot: "Бот",
  group: "Группа",
  space: "Пространство",
  chats: "Чаты",
  routine: "Задача",
  member: "Участник",
  subagent: "субагент",
  owner: "Владелец",
};

describe("localized identity projections", () => {
  it("localizes invalid names without translating legitimate names or mutating wire values", () => {
    const source = [
      {
        id: "group-1",
        name: "__TestTok1__",
        members: [
          { name: "Group", botId: "bot-1" },
          { name: "__TestTok2__", botId: "bot-2" },
        ],
      },
    ];
    expect(displayIdentityResult(["groups", "list"], source, labels)).toMatchObject([
      {
        ...source[0],
        name: "Группа",
        members: [
          { name: "Group", botId: "bot-1" },
          { name: "Бот", botId: "bot-2" },
        ],
      },
    ]);
    expect(source[0]?.name).toBe("__TestTok1__");
  });
  it("localizes routine names in batched mention reads like per-bot reads", () => {
    const routines = [{ id: "routine-1", name: "__TestTok1__" }];
    expect(
      displayIdentityResult(
        ["routines", "listForMentions"],
        [{ botId: "bot-1", routines }],
        labels,
      ),
    ).toEqual([
      { botId: "bot-1", routines: displayIdentityResult(["routines", "list"], routines, labels) },
    ]);
  });
  it("covers bootstrap, threads and activity without touching message text or IDs", () => {
    const message = {
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "__route__",
          fromBotName: "__TestTok1__",
          text: "Keep __TestTok1__ literal",
        },
      ],
    };
    expect(
      displayIdentityResult(
        ["bootstrap"],
        {
          bots: [{ name: "__TestTok1__" }],
          groups: [{ name: "" }],
          thread: { messages: [message] },
        },
        labels,
      ),
    ).toMatchObject({
      bots: [{ name: "Бот" }],
      groups: [{ name: "Группа" }],
      thread: {
        messages: [
          {
            blocks: [
              { fromBotName: "Бот", fromBotId: "__route__", text: "Keep __TestTok1__ literal" },
            ],
          },
        ],
      },
    });
    expect(
      displayIdentityResult(["runs", "list"], { runs: [{ botName: "", groupName: null }] }, labels),
    ).toMatchObject({ runs: [{ botName: "Бот", groupName: null }] });
  });
  it("leaves provider configuration and file metadata alone", () => {
    const result = { name: "__TestTok1__", content: { botName: "__TestTok1__" } };
    expect(displayIdentityResult(["artifacts", "get"], result, labels)).toBe(result);
  });
  it("uses the current client locale for streamed metadata", () => {
    expect(
      displayIdentityEvent({ type: "thread.subagent", payload: { name: "__TestTok1__" } }, labels)
        .payload.name,
    ).toBe("субагент");
  });
});

it("keeps server-projected subagent names localizable at the client boundary", () => {
  const messages = projectMessages([
    {
      id: "event",
      createdAt: "2026-01-01T00:00:00.000Z",
      runId: "run",
      threadId: "thread",
      seq: 1,
      type: "thread.subagent",
      payload: { agentId: "agent", name: "__TestTok1__", task: "Summarize" },
    },
  ]);
  expect(messages[0]?.blocks[0]).toMatchObject({ name: "__TestTok1__" });
  expect(displayIdentityResult(["threads", "get"], { messages }, labels)).toMatchObject({
    messages: [{ blocks: [{ name: "субагент" }] }],
  });
});

it("guards newly posted board comments", () => {
  expect(
    displayIdentityResult(
      ["tickets", "comment"],
      { authorName: "__TestTok1__", authorBotId: null },
      labels,
    ),
  ).toMatchObject({ authorName: "Участник" });
});
it("guards message search titles while preserving link URLs", () => {
  const result = displayIdentityResult(
    ["search", "query"],
    {
      hits: [
        { kind: "message", botId: "bot", botName: "__TestTok1__", title: "__TestTok1__" },
        { kind: "message", groupId: "group", groupName: "__TestTok1__", title: "__TestTok1__" },
        { kind: "link", title: "https://example.com/__TestTok1__" },
      ],
    },
    labels,
  );
  expect(result).toMatchObject({
    hits: [{ title: "Бот" }, { title: "Группа" }, { title: "https://example.com/__TestTok1__" }],
  });
});

it("preserves null thread group names", () => {
  expect(displayIdentityResult(["threads", "get"], { groupName: null }, labels)).toEqual({
    groupName: null,
  });
});

it("keeps source names through live subagent projection and object spreads", () => {
  const event = displayIdentityEvent(
    {
      id: "event",
      threadId: "thread",
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "thread.subagent",
      payload: { agentId: "agent", name: "__TestTok1__", task: "Summarize" },
    },
    labels,
  );
  const messages = projectMessages([event]);
  expect(messages[0]?.blocks[0]).toMatchObject({ kind: "subagent", name: "субагент" });
  const block = { ...messages[0]!.blocks[0]! };
  expect(identitySource(block)).toMatchObject({ kind: "subagent", name: "__TestTok1__" });
  expect(identitySource({ ...block, name: "Ada" })).toMatchObject({ name: "Ada" });
});
