import { GROUP_MEMBER_MAX } from "@rakazo/contracts";

type DraggedBot = { id: string; sectionId: string | null; pinned: boolean };

export type RosterDropTarget =
  | { kind: "bot"; chat: { id: string; sectionId: string | null; pinned: boolean } }
  | { kind: "group"; chat: { id: string; memberIds: readonly string[] } }
  | { kind: "section"; sectionId: string | null };

export type RosterDropAction =
  | { action: "reorder"; targetBotId: string }
  | { action: "move"; sectionId: string | null }
  | { action: "join"; groupId: string; botIds: string[] };

/**
 * Decide what dropping a dragged bot on a sidebar target does. Dropping on a
 * sibling row reorders; dropping on another section (its header or one of its
 * rows) moves the bot there; dropping on a group chat adds the bot as a member.
 * Pinned bots live in the Pinned list, so they only reorder. Returns null when
 * the drop should be refused.
 */
export function resolveRosterDrop(input: {
  dragged: DraggedBot;
  target: RosterDropTarget;
  /** True when the target and dragged rows belong to the same visible list. */
  sameList: boolean;
}): RosterDropAction | null {
  const { dragged, target } = input;
  switch (target.kind) {
    case "bot": {
      if (target.chat.id === dragged.id) return null;
      if (dragged.pinned !== target.chat.pinned) return null;
      if (dragged.pinned || target.chat.sectionId === dragged.sectionId) {
        return input.sameList ? { action: "reorder", targetBotId: target.chat.id } : null;
      }
      return { action: "move", sectionId: target.chat.sectionId };
    }
    case "section": {
      if (dragged.pinned || target.sectionId === dragged.sectionId) return null;
      return { action: "move", sectionId: target.sectionId };
    }
    case "group": {
      const members = target.chat.memberIds;
      if (members.includes(dragged.id) || members.length >= GROUP_MEMBER_MAX) return null;
      return { action: "join", groupId: target.chat.id, botIds: [...members, dragged.id] };
    }
  }
}
