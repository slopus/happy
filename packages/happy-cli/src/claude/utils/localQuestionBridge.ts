/**
 * Surfaces a local-mode question on the phone, and routes the answer back.
 *
 * In local mode Claude runs as its own binary in the terminal, so Happy has no
 * `canUseTool` hook to intercept an `AskUserQuestion` with — `permissionHandler`
 * is wired only into remote mode. The phone therefore shows the session as
 * merely online while the terminal sits blocked on a question, and the answer
 * sheet it already renders cannot submit: `AskUserQuestionView` only calls
 * `sessionAllow` when `tool.permission` exists, and that is derived from
 * `agentState.requests`, which nothing populates here. The button spins and
 * sends nothing.
 *
 * This publishes the open question into `agentState.requests`, which is the one
 * input the app's session state derives "needs attention" from, and registers
 * the `permission` RPC so the answer has somewhere to land.
 *
 * The answer cannot be returned as a `tool_result`: that would require being
 * inside the tool call, which is exactly what local mode is not. It is enqueued
 * as a user message instead, which the queue's existing handler turns into a
 * handoff to remote mode — the same thing the user does by hand today when they
 * type into the app to take over. So the turn is interrupted rather than
 * resumed, and Claude reads the answer as text. That is a real semantic
 * difference from remote mode, and the reason this is not simply "local mode
 * now supports questions".
 */

import { logger } from "@/ui/logger";
import type { Session } from "../session";
import { findPendingQuestion } from "./pendingQuestion";

/** Formats the app's answer map into the message Claude will read. */
function formatAnswer(answers: Record<string, unknown>): string {
  const lines = Object.entries(answers)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([question, value]) => `- ${question}: ${value as string}`);
  return lines.length === 0
    ? "(the question was answered with no selection)"
    : `Answering your question from the phone:\n${lines.join("\n")}`;
}

export interface LocalQuestionBridge {
  /** Feed from the status watcher: true while Claude is blocked on a question. */
  onWaitingForInputChange: (waitingForInput: boolean) => void;
  /** Withdraw anything published and stop accepting answers. */
  dispose: () => void;
}

export function startLocalQuestionBridge(
  session: Session,
): LocalQuestionBridge {
  // Id of the question currently published, so we withdraw exactly our own
  // entry and never clobber a concurrent writer's.
  let publishedId: string | null = null;
  let disposed = false;
  // Bumped on every state change. `findPendingQuestion` reads a file, so a
  // quick true→false flip could otherwise publish after the withdraw and leave
  // the phone offering to answer a question Claude has moved on from.
  let generation = 0;

  const withdraw = (reason: string) => {
    const id = publishedId;
    if (!id) {
      return;
    }
    publishedId = null;
    logger.debug(`[LocalQuestion] withdrawing ${id}: ${reason}`);
    session.client.updateAgentState((state) => {
      if (!state.requests?.[id]) {
        return state;
      }
      const requests = { ...state.requests };
      delete requests[id];
      return { ...state, requests };
    });
  };

  const publish = async () => {
    const mine = ++generation;
    const sessionId = session.sessionId;
    if (!sessionId) {
      return;
    }
    const pending = await findPendingQuestion(session.path, sessionId);
    // Either we were disposed, or the status flipped again while reading the
    // transcript. In both cases this result is already stale.
    if (disposed || mine !== generation || !pending) {
      return;
    }
    // Key by the provider tool-use id, and echo it in `toolUseId`: the app
    // joins a request to its tool call by `toolUseId || requestId`, so both
    // being the same id attaches the answer sheet to the question already
    // visible in the transcript instead of adding a second card.
    publishedId = pending.toolUseId;
    logger.debug(`[LocalQuestion] publishing ${pending.toolUseId}`);
    session.client.updateAgentState((state) => ({
      ...state,
      requests: {
        ...state.requests,
        [pending.toolUseId]: {
          tool: "AskUserQuestion",
          arguments: pending.input,
          createdAt: Date.now(),
          toolUseId: pending.toolUseId,
        },
      },
    }));
  };

  session.client.rpcHandlerManager.registerHandler<
    { id?: unknown; approved?: unknown; updatedInput?: unknown },
    void
  >("permission", async (message) => {
    const id = typeof message?.id === "string" ? message.id : null;
    if (!id || id !== publishedId) {
      // Not the question we published — a stale response, or one belonging to a
      // request from another mode. Dropping it is safer than enqueueing text
      // Claude never asked for.
      logger.debug(
        `[LocalQuestion] ignoring permission response for ${id ?? "?"}`,
      );
      return;
    }

    if (message.approved !== true) {
      // The app has no "deny" for a question today, so this is defensive. The
      // terminal prompt is the user's to resolve either way.
      logger.debug("[LocalQuestion] question was declined, nothing to enqueue");
      withdraw("declined");
      return;
    }

    const updatedInput =
      message.updatedInput && typeof message.updatedInput === "object"
        ? (message.updatedInput as { answers?: unknown })
        : null;
    const answers =
      updatedInput?.answers && typeof updatedInput.answers === "object"
        ? (updatedInput.answers as Record<string, unknown>)
        : null;
    // The mode has to be the live one: the queue keys its batches by a hash of
    // it, so a hardcoded default would resume with a different model than the
    // user picked.
    const mode = session.getEnhancedMode?.();

    // Validate before touching state. Withdrawing and then failing to enqueue
    // would clear the question from the phone while the terminal stays blocked
    // on it, and since the status file has not changed, nothing would republish
    // it — the session would look idle with no way back.
    if (!answers || !mode) {
      logger.debug(
        `[LocalQuestion] cannot forward the answer (answers=${!!answers} mode=${!!mode}); leaving the question published`,
      );
      return;
    }

    // Enqueueing triggers the queue's onMessage handler, which asks local mode
    // to hand control to remote. That ends the terminal session the question
    // belonged to, so withdrawing is not cosmetic: the prompt stops existing.
    withdraw("answered");
    session.queue.push(formatAnswer(answers), mode);
    logger.debug("[LocalQuestion] answer enqueued, handing off to remote");
  });

  return {
    onWaitingForInputChange: (waitingForInput) => {
      if (disposed) {
        return;
      }
      if (waitingForInput) {
        void publish();
      } else {
        generation++;
        withdraw("no longer waiting");
      }
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      generation++;
      withdraw("local mode ended");
      // Remote mode's PermissionHandler registers its own `permission` handler
      // when it starts, but local mode can also exit for good. Leave a no-op
      // rather than a handler closing over disposed state, matching how this
      // launcher retires `abort` and `switch`.
      session.client.rpcHandlerManager.registerHandler(
        "permission",
        async () => {},
      );
    },
  };
}
