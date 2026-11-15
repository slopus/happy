import { fetchFresh } from "@rakazo/core/query";
import type { RefObject } from "react";
import { useCallback, useState } from "react";
import type { spaceQueries } from "../../lib/query";
import { queryClient } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import type { useThreadState } from "./use-thread-state";

/**
 * Stopping a skill being taught on the computer, and reading its state back once the computer
 * recovers. Both act on the bot open now, read through `activeBotId`.
 */
export function useTeaching({
  rpc,
  queries,
  thread,
  activeBotId,
  refreshThreadRef,
  closeComputer,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: ReturnType<typeof spaceQueries>;
  thread: ReturnType<typeof useThreadState>;
  activeBotId: RefObject<string | undefined>;
  refreshThreadRef: RefObject<(botId: string) => Promise<unknown>>;
  closeComputer: () => void;
}) {
  const [teachBusy, setTeachBusy] = useState(false);
  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = thread.taughtSkills.find(
      (skill) => skill.status === "recording" && thread.taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      closeComputer();
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, thread.taughtSkills, thread.taughtSkillsBotId]);
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await fetchFresh(
      queryClient,
      queries.skills.list.queryOptions({ input: { botId: id } }),
    );
    if (activeBotId.current !== id) return;
    thread.setTaughtSkills(skills);
    thread.setTaughtSkillsBotId(id);
  }, []);
  return { teachBusy, stopTeaching, refreshActiveTeaching };
}
