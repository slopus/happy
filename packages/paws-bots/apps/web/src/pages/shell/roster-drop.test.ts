import { GROUP_MEMBER_MAX } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { resolveRosterDrop } from "./roster-drop";

const bot = (id: string, sectionId: string | null, pinned = false) => ({
  id,
  sectionId,
  pinned,
});
const group = (id: string, sectionId: string | null, memberIds: string[]) => ({
  id,
  sectionId,
  memberIds,
});

describe("resolveRosterDrop", () => {
  it("reorders when the bot is dropped on a sibling in the same section", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("b", "s1") },
        sameList: true,
      }),
    ).toEqual({ action: "reorder", targetBotId: "b" });
  });

  it("refuses a reorder across tree levels inside one section", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("b", "s1") },
        sameList: false,
      }),
    ).toBeNull();
  });

  it("moves to the target bot's section when the sections differ", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("b", "s2") },
        sameList: false,
      }),
    ).toEqual({ action: "move", sectionId: "s2" });
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("b", null) },
        sameList: false,
      }),
    ).toEqual({ action: "move", sectionId: null });
  });

  it("moves to a section header, including Unassigned", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", null),
        target: { kind: "section", sectionId: "s2" },
        sameList: false,
      }),
    ).toEqual({ action: "move", sectionId: "s2" });
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "section", sectionId: null },
        sameList: false,
      }),
    ).toEqual({ action: "move", sectionId: null });
  });

  it("does nothing when dropped on the header of its own section", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "section", sectionId: "s1" },
        sameList: false,
      }),
    ).toBeNull();
  });

  it("never moves a pinned bot into a section; pinned rows only reorder", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", null, true),
        target: { kind: "section", sectionId: "s2" },
        sameList: false,
      }),
    ).toBeNull();
    expect(
      resolveRosterDrop({
        dragged: bot("a", null, true),
        target: { kind: "bot", chat: bot("b", "s2") },
        sameList: false,
      }),
    ).toBeNull();
  });

  it("joins a group chat when dropped on it", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "group", chat: group("g1", null, ["b", "c"]) },
        sameList: false,
      }),
    ).toEqual({ action: "join", groupId: "g1", botIds: ["b", "c", "a"] });
  });

  it("refuses to join a group it already belongs to or one that is full", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", null),
        target: { kind: "group", chat: group("g1", null, ["a", "b"]) },
        sameList: false,
      }),
    ).toBeNull();
    expect(
      resolveRosterDrop({
        dragged: bot("z", null),
        target: {
          kind: "group",
          chat: group(
            "g1",
            null,
            Array.from({ length: GROUP_MEMBER_MAX }, (_, i) => `m${i}`),
          ),
        },
        sameList: false,
      }),
    ).toBeNull();
  });

  it("ignores a drop on itself", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("a", "s1") },
        sameList: true,
      }),
    ).toBeNull();
  });
});
