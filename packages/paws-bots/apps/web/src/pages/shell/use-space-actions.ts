import { hostNavigate } from "../../paws/runtime";
import type { RefObject } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { selectedSpaceId, selectSpace } from "../../lib/rpc";
import { commitSpaceRename } from "./space-sidebar";
import type { useSpaceRoster } from "./use-space-roster";

type Roster = ReturnType<typeof useSpaceRoster>;

/** Renaming, removing, and leaving a space; leaving the open one reloads like a space switch. */
export function useSpaceActions({
  rpc,
  alive,
  setSpaces,
  refreshBots,
  bootstrapMe,
  closePanel,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  alive: RefObject<boolean>;
  setSpaces: Roster["setSpaces"];
  refreshBots: Roster["refreshBots"];
  bootstrapMe: Roster["bootstrapMe"];
  closePanel: () => void;
}) {
  async function renameSpace(spaceId: string, name: string) {
    await commitSpaceRename({
      rename: async () => {
        await rpc.spaces.rename({ spaceId, name });
      },
      apply: () => {
        setSpaces((current) =>
          current.map((space) => (space.id === spaceId ? { ...space, name } : space)),
        );
      },
      refresh: () => refreshBots(),
    });
  }

  async function removeSpace(spaceId: string) {
    const result = await rpc.spaces.remove({ spaceId });
    if (!alive.current) return;
    closePanel();
    const effectiveSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId;
    if (effectiveSpaceId === spaceId) {
      // The auth boundary changed, so reload like a space switch.
      if (selectSpace(result.activeSpaceId)) {
        hostNavigate("/app");
        return;
      }
    }
    await refreshBots(true);
  }

  async function leftSpace(spaceId: string, activeSpaceId: string) {
    const effectiveSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId;
    // Leaving the open space changes the auth boundary, so reload like a space switch.
    if (effectiveSpaceId === spaceId && selectSpace(activeSpaceId)) {
      hostNavigate("/app");
      return;
    }
    await refreshBots(true);
  }

  return { renameSpace, removeSpace, leftSpace };
}
