import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, Space } from "@rakazo/contracts";
import { createSnoozeQueue } from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { rpcForSpace } from "../../lib/rpc";

export type SnoozeTarget = {
  kind: "bot" | "group";
  id: string;
  spaceId: string;
  snoozedUntil?: string | null;
};
export type SnoozeChat = (chat: SnoozeTarget, until: string | null) => void;

/** Snoozes or unsnoozes a chat in any listed space; the roster moves it at once. */
export function useChatSnooze({
  rpc,
  openSpaceId,
  setBots,
  setGroups,
  setSpaces,
  refreshBots,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  openSpaceId: string | undefined;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  setSpaces: Dispatch<SetStateAction<Space[]>>;
  refreshBots: () => Promise<void>;
}): SnoozeChat {
  const { t } = useLingui();
  const [queue] = useState(createSnoozeQueue);
  return useCallback(
    (chat, until) => {
      const apply = (value: string | null) => {
        const set = <T extends { id: string; snoozedUntil?: string | null }>(chats: T[]) =>
          chats.map((item) => (item.id === chat.id ? { ...item, snoozedUntil: value } : item));
        if (chat.spaceId === openSpaceId) {
          if (chat.kind === "bot") setBots(set);
          else setGroups(set);
        }
        setSpaces((spaces) =>
          spaces.map((space) =>
            space.id !== chat.spaceId
              ? space
              : chat.kind === "bot"
                ? { ...space, bots: set(space.bots) }
                : { ...space, groups: set(space.groups) },
          ),
        );
      };
      const client = chat.spaceId === openSpaceId ? rpc : rpcForSpace(chat.spaceId);
      const target = chat.kind === "bot" ? { botId: chat.id } : { groupId: chat.id };
      queue(`${chat.kind}:${chat.id}`, until, chat.snoozedUntil ?? null, {
        send: (value) => client.threads.snooze({ ...target, until: value }),
        apply,
        settled: (failed) => {
          if (failed) toast.error(t`Could not save`);
          void refreshBots().catch(() => undefined);
        },
      });
    },
    [rpc, openSpaceId, setBots, setGroups, setSpaces, refreshBots, t, queue],
  );
}
