import type { RunStatus } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { activityAttention, activitySections } from "./activity-sections.js";
import { STUCK_WORK_NOTIFY_AFTER_MS } from "./stuck-work.js";

const now = new Date().toISOString();
const run = (botId: string, status: RunStatus, groupId: string | null = null, updatedAt = now) =>
  ({ botId, groupId, status, updatedAt }) as const;

it.each([
  ["waiting_input", false, "needs_attention"],
  ["waiting_takeover", false, "needs_attention"],
  ["failed", true, "needs_attention"],
  ["failed", false, null],
  ["running", true, "working"],
  ["queued", false, "working"],
  ["completed", true, "unread"],
  ["cancelled", false, null],
] as const)("classifies %s (unread %s) as %s", (status, unread, state) => {
  expect(activityAttention(run("bot", status), unread)).toBe(state);
});

it("calls out a queue that has sat past the reminder", () => {
  const old = new Date(Date.now() - STUCK_WORK_NOTIFY_AFTER_MS).toISOString();
  expect(activityAttention(run("bot", "queued", null, old))).toBe("needs_attention");
});

it("puts each conversation in one section", () => {
  const ask = run("marketing", "waiting_input");
  const work = run("research", "running", "launch");
  const failedUnread = run("writer", "failed");
  const done = run("editor", "completed");
  const doneUnread = run("chief", "completed");
  const sections = activitySections({
    active: [ask, work],
    recent: [failedUnread, done, doneUnread],
    bots: [
      { id: "research", unread: true },
      { id: "writer", unread: true },
      { id: "editor", unread: false },
      { id: "chief", unread: true },
      { id: "marketing", unread: true },
    ],
    groups: [
      { id: "launch", unread: true },
      { id: "quiet", unread: true },
    ],
  });
  expect(sections.attention).toEqual([ask, failedUnread]);
  expect(sections.working).toEqual([work]);
  expect(sections.unreadBots.map((bot) => bot.id)).toEqual(["research", "chief"]);
  expect(sections.unreadGroups.map((group) => group.id)).toEqual(["quiet"]);
  expect(sections.recent).toEqual([done]);
});

it("judges a chat by its latest run only", () => {
  const sections = activitySections({
    active: [],
    recent: [run("writer", "completed"), run("writer", "failed"), run("editor", "failed")],
    bots: [
      { id: "writer", unread: true },
      { id: "editor", unread: true },
      { id: "chief", unread: true },
    ],
    groups: [],
  });
  expect(sections.attention).toEqual([run("editor", "failed")]);
  // A failure older than the fetched runs still leaves the chat under Unread.
  expect(sections.unreadBots.map((bot) => bot.id)).toEqual(["writer", "chief"]);
});

it("lists each finished chat once in Recent, by its latest run", () => {
  const latestWriter = run("writer", "failed");
  const editor = run("editor", "completed");
  const sections = activitySections({
    active: [run("chief", "running")],
    recent: [latestWriter, editor, run("writer", "completed"), run("chief", "completed")],
    bots: [],
    groups: [],
  });
  expect(sections.recent).toEqual([latestWriter, editor]);
});

it("lets live work speak for a chat over its older outcome", () => {
  const working = run("writer", "running");
  const asking = run("launcher", "waiting_input", "launch");
  const sections = activitySections({
    active: [working, run("launcher", "running", "launch"), asking],
    recent: [run("writer", "failed"), run("launcher", "failed", "launch")],
    bots: [{ id: "writer", unread: true }],
    groups: [{ id: "launch", unread: true }],
  });
  expect(sections.attention).toEqual([asking]);
  expect(sections.working).toEqual([working]);
  expect(sections.unreadBots).toEqual([]);
  expect(sections.unreadGroups).toEqual([]);
});

it("leaves a snoozed chat out until it wakes, even one waiting on the user", () => {
  const wake = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
  const input = {
    active: [run("asleep", "waiting_input"), run("awake", "waiting_input")],
    recent: [],
    bots: [
      { id: "asleep", unread: true, snoozedUntil: wake },
      { id: "awake", unread: false },
    ],
    groups: [{ id: "quiet", unread: true, snoozedUntil: wake }],
  };
  const sections = activitySections({ ...input, now: Date.parse(now) });
  expect(sections.attention.map((item) => item.botId)).toEqual(["awake"]);
  expect(sections.unreadBots).toEqual([]);
  expect(sections.unreadGroups).toEqual([]);
  // Once it wakes, it is back.
  const woken = activitySections({ ...input, now: Date.parse(wake) + 1 });
  expect(woken.attention.map((item) => item.botId)).toEqual(["asleep", "awake"]);
});
