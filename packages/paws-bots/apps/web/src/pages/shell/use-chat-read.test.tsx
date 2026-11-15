// @vitest-environment jsdom
import type { Bot, Group } from "@rakazo/contracts";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useChatRead } from "./use-chat-read";

type Request = {
  kind: "markRead" | "markUnread";
  input: { botId?: string; groupId?: string; messageId?: string };
  resolve: () => void;
  reject: (error: Error) => void;
};

const botA = { id: "bot-a", unread: true } as Bot;
const botB = { id: "bot-b", unread: false } as Bot;
const groupG = { id: "group-g", unread: true } as Group;

let requests: Request[];
let focused: boolean;
let root: Root;
let latest: {
  read: ReturnType<typeof useChatRead>;
  bots: Bot[];
  groups: Group[];
};

function request(kind: Request["kind"]) {
  return (input: Request["input"]) =>
    new Promise((resolve, reject) => {
      requests.push({
        kind,
        input,
        resolve: () => resolve(kind === "markRead" ? { unreadAfterSeq: 5 } : {}),
        reject,
      });
    });
}

const rpc = {
  threads: { markRead: request("markRead"), markUnread: request("markUnread") },
} as unknown as ReturnType<typeof createSpaceRpc>;

function Harness({ active, group }: { active?: Bot; group?: Group }) {
  const [bots, setBots] = useState([botA, botB]);
  const [groups, setGroups] = useState([groupG]);
  const read = useChatRead({
    rpc,
    active,
    groupId: group?.id,
    activeGroup: group,
    setBots,
    setGroups,
  });
  latest = { read, bots, groups };
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function open(chat: { active?: Bot; group?: Group }) {
  act(() => root.render(<Harness {...chat} />));
  await flush();
}

async function settle(index: number) {
  await flush();
  requests[index]!.resolve();
  await flush();
}

async function focus() {
  act(() => window.dispatchEvent(new Event("focus")));
  await flush();
}

const sent = () => requests.map(({ kind, input }) => [kind, input.botId ?? input.groupId]);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests = [];
  focused = true;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useChatRead automatic reads", () => {
  it("reads an open bot and clears its unread flag", async () => {
    await open({ active: botA });
    expect(sent()).toEqual([["markRead", "bot-a"]]);
    await settle(0);
    expect(latest.bots.find((bot) => bot.id === "bot-a")?.unread).toBe(false);
    expect(latest.read.unreadAfterSeq).toBe(5);
  });

  it("skips a queued bot read once the window loses focus", async () => {
    await open({ active: botA });
    await focus();
    focused = false;
    await settle(0);
    expect(sent()).toEqual([["markRead", "bot-a"]]);
  });

  it("skips a queued bot read once the user opens another chat", async () => {
    await open({ active: botA });
    await focus();
    await open({ active: botB });
    await settle(0);
    expect(sent()).toEqual([
      ["markRead", "bot-a"],
      ["markRead", "bot-b"],
    ]);
  });

  it("skips a queued group read once the window loses focus", async () => {
    await open({ group: groupG });
    act(() => latest.read.markGroupReadOnReply("group-g"));
    focused = false;
    await settle(0);
    expect(sent()).toEqual([["markRead", "group-g"]]);
  });

  it("skips a queued group read once the user opens another chat", async () => {
    await open({ group: groupG });
    act(() => latest.read.markGroupReadOnReply("group-g"));
    await open({ active: botB });
    await settle(0);
    expect(sent()).toEqual([
      ["markRead", "group-g"],
      ["markRead", "bot-b"],
    ]);
  });
});

describe("useChatRead Mark as Unread", () => {
  it("leaves a group marked unread alone until it is opened again, like a bot", async () => {
    await open({ group: groupG });
    await settle(0);
    act(() => latest.read.markGroupUnreadFrom("group-g", "message-1"));
    await settle(1);
    expect(latest.groups[0]?.unread).toBe(true);
    expect(latest.read.markedUnreadMessageId).toBe("message-1");

    act(() => latest.read.markGroupReadOnReply("group-g"));
    await flush();
    expect(sent()).toEqual([
      ["markRead", "group-g"],
      ["markUnread", "group-g"],
    ]);

    await open({ active: botB });
    await open({ group: groupG });
    expect(sent().at(-1)).toEqual(["markRead", "group-g"]);
  });

  it("queues a bot's unread write behind its read and skips reads queued before the hold", async () => {
    await open({ active: botA });
    await focus();
    const unread = latest.read.markBotUnread("bot-a", "message-1");
    await flush();
    expect(sent()).toEqual([["markRead", "bot-a"]]);

    await settle(0);
    expect(sent()).toEqual([
      ["markRead", "bot-a"],
      ["markUnread", "bot-a"],
    ]);
    await settle(1);
    await act(() => unread);
    expect(latest.bots.find((bot) => bot.id === "bot-a")?.unread).toBe(true);
    expect(latest.read.markedUnreadMessageId).toBe("message-1");
  });

  it("queues a group's unread write behind its read and skips reads queued before the hold", async () => {
    await open({ group: groupG });
    act(() => latest.read.markGroupReadOnReply("group-g"));
    act(() => latest.read.markGroupUnreadFrom("group-g", "message-1"));
    await flush();
    expect(sent()).toEqual([["markRead", "group-g"]]);

    await settle(0);
    expect(sent()).toEqual([
      ["markRead", "group-g"],
      ["markUnread", "group-g"],
    ]);
  });

  it("never lets an automatic read's answer clear the hold; an explicit read does", async () => {
    await open({ active: botA });
    const unread = latest.read.markBotUnread("bot-a");
    await settle(0);
    await settle(1);
    await act(() => unread);
    expect(latest.bots.find((bot) => bot.id === "bot-a")?.unread).toBe(true);

    await focus();
    expect(sent()).toHaveLength(2);

    const read = latest.read.markBotRead("bot-a");
    await flush();
    await settle(2);
    await act(() => read);
    expect(latest.bots.find((bot) => bot.id === "bot-a")?.unread).toBe(false);
    await focus();
    expect(sent().at(-1)).toEqual(["markRead", "bot-a"]);
    expect(sent()).toHaveLength(4);
  });

  it("drops a group's hold when its chat-list Mark as Unread fails", async () => {
    await open({ group: groupG });
    await settle(0);
    act(() => latest.read.toggleGroupUnread("group-g", true));
    await flush();
    requests[1]!.reject(new Error("offline"));
    await flush();
    expect(latest.groups[0]?.unread).toBe(false);

    act(() => latest.read.markGroupReadOnReply("group-g"));
    await flush();
    expect(sent().at(-1)).toEqual(["markRead", "group-g"]);
  });

  it("keeps a group's hold when its chat-list Mark as Unread succeeds", async () => {
    await open({ group: groupG });
    await settle(0);
    act(() => latest.read.toggleGroupUnread("group-g", true));
    await flush();
    await settle(1);
    expect(latest.groups[0]?.unread).toBe(true);

    act(() => latest.read.markGroupReadOnReply("group-g"));
    await flush();
    expect(sent()).toHaveLength(2);
  });
});
