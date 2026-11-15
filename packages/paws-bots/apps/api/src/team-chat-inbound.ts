import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import type { TeamChat } from "@rakazo/adapters";
import { toTeamChatInbound } from "@rakazo/adapters";
import { SpaceDeletionInProgressError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MessagingInboundDeps } from "./messaging-inbound.js";
import { teamChatSenderCanWakeMessageRoutines, wakeMessageRoutines } from "./messaging-inbound.js";
import type { TeamChatBridge } from "./team-chat-bridge.js";

/**
 * Routes one TeamChat delivery: a sender who may wake message routines gets them first, with the
 * message deferred until routing settles, and the bridge's own agent only when no routine took
 * it. A routine and the agent each claim the message in the transaction that starts their run,
 * so only one of them answers. Should this process stop mid-way, the message's job hands it to
 * the agent once routing's time is up.
 */
export function createTeamChatInboundHandler(
  inboundDeps: MessagingInboundDeps,
  inbound: (event: MessagingInboundMessage) => Promise<void>,
  teamChat: Pick<TeamChat, "routeToAgent" | "drop">,
) {
  return async (bridge: TeamChatBridge, event: Parameters<typeof wakeMessageRoutines>[2]) => {
    const mapped = toTeamChatInbound(event);
    if (!mapped) {
      await inbound(event);
      return;
    }
    if (!(await teamChatSenderCanWakeMessageRoutines(inboundDeps, event))) {
      await bridge.receive(mapped);
      return;
    }
    const target = await bridge.receive(mapped, { defer: true });
    if (!target.deferred) return;
    let woken: boolean;
    try {
      woken = await wakeMessageRoutines(inboundDeps, target, event, {
        // Must match the bridge's ExternalConversation provider and wake nonce.
        deliveryProvider: bridge.providerId,
        externalMessageId: target.externalMessageId,
      });
    } catch (error) {
      // A Space being deleted takes no message: accepted and dropped, with no agent fallback, so
      // the provider does not redeliver it. Its transcript copy stays.
      if (error instanceof SpaceDeletionInProgressError) {
        await teamChat.drop(target.externalMessageId, ["deferred"]);
        getLogger().info("messaging inbound dropped", { reason: "space being deleted" });
        return;
      }
      await teamChat.routeToAgent(target.externalMessageId, mapped.kind);
      throw error;
    }
    if (!woken) await teamChat.routeToAgent(target.externalMessageId, mapped.kind);
  };
}
