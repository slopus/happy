import type { MessagingInboundMessage } from "@rakazo/adapter-kit";

export function prefersTeamChatSurface(
  event: Pick<MessagingInboundMessage, "provider" | "workspaceId" | "isDirect">,
  teamChatBotId: string | undefined | null,
): boolean {
  return (
    !event.isDirect &&
    Boolean(teamChatBotId) &&
    (event.provider === "slack" ||
      event.provider === "teamchat-emulator" ||
      Boolean(event.workspaceId))
  );
}

export function settleWithTimeout(
  task: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<"done" | "timeout"> {
  if (!task) return Promise.resolve("done");
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task.then(
      () => "done" as const,
      () => "done" as const,
    ),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
