import type { ProductEvent, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { foldPeerReplies, reduceThreadSnapshot } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { DEFAULT_BOT_AVATAR_COLOR } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useMemo, useRef } from "react";
import { rpc } from "../../src/lib/rpc";
import { Transcript } from "../../src/pages/shell/transcript";

export const BOT = { botId: "bot-1", name: "Chief", color: DEFAULT_BOT_AVATAR_COLOR };
const NO_IDS = new Set<string>();
const noop = () => {};
const resolved = async () => {};

export function threadEvent(seq: number, overrides: Partial<ProductEvent>): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: BOT.botId,
    seq,
    type: "thread.progress",
    runId: "run-1",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
}

/** Folds events through the same reducer the chat shell uses. */
export function reduceThreadEvents(events: Partial<ProductEvent>[]): ThreadSnapshot {
  const empty: ThreadSnapshot = {
    botId: BOT.botId,
    threadId: "thread-1",
    cursor: 0,
    messages: [],
    olderCursor: null,
    run: null,
  };
  return events.reduce<ThreadSnapshot>(
    (snapshot, event, index) =>
      reduceThreadSnapshot(snapshot, threadEvent(index + 1, event)) ?? snapshot,
    empty,
  );
}

/** The real chat transcript over fixture messages, with inert actions. */
export function FixtureTranscript({
  messages,
  running,
  showToolActivity,
  header,
  answerableAskIds = NO_IDS,
  bots = [BOT],
}: {
  messages: readonly ThreadMessage[];
  running: boolean;
  showToolActivity: boolean;
  header?: ReactNode;
  /** Messages whose ask cards take answers; the rest render as no longer active. */
  answerableAskIds?: Set<string>;
  /** The chat's own bot first, then any peers it mentions or hands off to. */
  bots?: GroupAvatarMember[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcript = useMemo(
    () => foldPeerReplies(messages, { includePeerReceipts: true }),
    [messages],
  );
  const bot = (botId: string | undefined) => bots.find((member) => member.botId === botId);
  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      {header}
      <Transcript
        rpc={rpc}
        scrollRef={scrollRef}
        scrollRequest={null}
        onScrollRequestHandled={noop}
        followRequest={0}
        callHoldsSpeaker={false}
        artifactTarget={{ botId: BOT.botId }}
        transcript={transcript}
        showToolActivity={showToolActivity}
        olderCursor={null}
        unreadAfterSeq={null}
        loadingOlder={false}
        answerableAskIds={answerableAskIds}
        dismissableAskIds={answerableAskIds}
        running={running}
        workingBots={running ? [bots[0]!] : []}
        onLoadOlder={noop}
        onOpenBot={noop}
        onAnswer={resolved}
        onReply={noop}
        onMarkUnread={noop}
        onQuote={noop}
        onReact={resolved}
        onJumpToMessage={noop}
        onOpenPeerMessages={noop}
        memberName={(botId) => bot(botId)?.name}
        peerBot={(botId) => bot(botId) ?? BOT}
        onRefresh={resolved}
        onBotChanged={resolved}
        onAddRoutine={noop}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={noop}
        onOpenComputer={noop}
        onReleaseComputer={async () => {}}
      />
    </main>
  );
}
