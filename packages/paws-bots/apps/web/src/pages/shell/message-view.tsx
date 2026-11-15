import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown, LinkifiedText, withBlockMentions } from "@rakazo/chat-ui/web";
import type {
  BotAvatarSet,
  ComputerReleaseReason,
  LoginFieldInput,
  MessageBlock,
  MessageReaction,
  ThreadMessage,
} from "@rakazo/contracts";
import type { ChildBotBlock, PeerExchange } from "@rakazo/core";
import { isPeerReceiptBlocks, isToolActivityBlock, otherAuthor } from "@rakazo/core";
import { BotAvatar, Button, cn, resolvePersonaColorDef } from "@rakazo/ui-web";
import { UserRound } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { ArtifactFileCard } from "../../components/ArtifactFileCard";
import { AskCard } from "../../components/AskCard";
import { CollaborationMarker } from "../../components/ai/CollaborationMarker";
import { CloudAgentCard } from "../../components/CloudAgentCard";
import { ComputerCard } from "../../components/ComputerCard";
import { McpAppCard } from "../../components/McpAppCard";
import { PageBlockCard } from "../../components/pages/PageBlockCard";
import { SubagentCard } from "../../components/SubagentCard";
import {
  LIVE_TOOL_STEP_WINDOW,
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "../../components/ToolActivityDisclosure";
import { SkillDraftCard } from "../../components/teach/SkillDraftCard";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { messageProviderLabel } from "../../lib/messaging";
import type { PageBlock } from "../../lib/page-cards";
import { useOpenPage } from "../../lib/pages";
import type { createSpaceRpc } from "../../lib/rpc";
import {
  isToolOnlyNarration,
  renderableMessageBlocks,
  shouldRenderToolCard,
  toolStepCount,
} from "../../lib/tool-activity-view";
import { ReplyLine } from "./chat-context";
import { FALLBACK_BOT_COLOR, previewMessageText } from "./chat-shared";
import type { ImportSetupTarget } from "./import-setup-card";
import { ImportSetupCard } from "./import-setup-card";
import {
  AppConnectCard,
  ArtifactImage,
  ChartBlockView,
  ChoiceCard,
  McpApprovalCard,
} from "./message-cards";
import { MessageHoverActions } from "./message-hover-actions";

export const MessageView = memo(function MessageView({
  artifactTarget,
  canAnswer,
  separateAnswers,
  canDismiss,
  message,
  meId,
  mentions,
  pages,
  isPageSuperseded,
  onAnswer,
  onOpenBot,
  onOpenPeerMessages,
  peerExchange,
  speakerName,
  memberName,
  peerBot,
  replyParent,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speaking,
  callHoldsSpeaker,
  onSpeak,
  onOpenComputer,
  onReleaseComputer,
  onOpenImportSetup,
  rpc,
  showToolActivity,
  onReply,
  onMarkUnread,
  markedUnread = false,
  onReact,
}: {
  artifactTarget: ArtifactTarget;
  canAnswer: boolean;
  separateAnswers?: ReadonlySet<MessageBlock>;
  canDismiss: boolean;
  message: ThreadMessage;
  /** The signed-in person; anyone else's message is named and set apart. */
  meId?: string;
  /** Bots this reply announces, named inline in its text. */
  mentions?: readonly ChildBotBlock[];
  /** Pages saved just before this reply, drawn under its text. */
  pages?: readonly PageBlock[];
  /** Whether a later card in the chat shows the same page. */
  isPageSuperseded?: (messageId: string, block: PageBlock) => boolean;
  onAnswer: (
    message: ThreadMessage,
    text: string,
    fields?: LoginFieldInput[],
    dismiss?: boolean,
    remember?: false,
  ) => Promise<void>;
  onOpenBot: (botId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  /** The adjacent receipts represented by this peer line. */
  peerExchange?: PeerExchange;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (
    botId: string,
  ) => { name?: string; color: string; status?: string; avatarSet?: BotAvatarSet } | undefined;
  replyParent?: ThreadMessage;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  /** An active call owns the speaker, so new reads wait until it ends. */
  callHoldsSpeaker: boolean;
  onSpeak: (message: ThreadMessage) => void;
  onOpenComputer: (botId?: string, takeControl?: boolean) => void;
  onReleaseComputer: (
    botId: string,
    runId: string | undefined,
    reason: ComputerReleaseReason,
  ) => Promise<void>;
  /** Opens where an imported item's setup is finished. */
  onOpenImportSetup?: (target: ImportSetupTarget) => void;
  rpc: ReturnType<typeof createSpaceRpc>;
  showToolActivity: boolean;
  onReply: (message: ThreadMessage) => void;
  onMarkUnread: (message: ThreadMessage) => void;
  markedUnread?: boolean;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
}) {
  const { t } = useLingui();
  const isNarration =
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) => block.kind === "text" || block.kind === "progress" || block.kind === "steps",
    );
  const isLive = message.id.startsWith("progress:");
  const quoteMessageId = message.id.includes(":") ? undefined : message.id;

  // Only what is drawn names the mentioned bots; copy, quote, and speech keep the original text.
  const blocks = useMemo(
    () =>
      mentions?.length
        ? withBlockMentions(
            message.blocks,
            mentions.map((bot) => ({ id: bot.botId, name: bot.name })),
          )
        : message.blocks,
    [message.blocks, mentions],
  );
  const openPage = useOpenPage();
  const pageCards = pages?.length ? (
    <div className="mt-3 flex flex-col gap-3">
      {pages.map((page) => (
        <PageBlockCard
          key={`${page.pageId}:${page.version}`}
          block={page}
          updated={isPageSuperseded?.(message.id, page) ?? false}
        />
      ))}
    </div>
  ) : null;
  const visibleNarrationBlocks = renderableMessageBlocks(blocks, showToolActivity);
  const renderMention = useCallback(
    (id: string) => {
      const block = mentions?.find((bot) => bot.botId === id);
      return block ? (
        <BotMention
          block={block}
          avatarSet={peerBot(id)?.avatarSet}
          color={peerBot(id)?.color}
          onOpenBot={onOpenBot}
        />
      ) : undefined;
    },
    [mentions, onOpenBot, peerBot],
  );
  const speak = () => onSpeak(message);
  const replyBotId = message.replyPreview?.botId ?? replyParent?.botId;
  const author = message.role === "user" ? otherAuthor(message.author, meId) : undefined;
  const replyAuthor = otherAuthor(message.replyPreview?.author ?? replyParent?.author, meId);
  const speakerBot = message.botId ? peerBot?.(message.botId) : undefined;
  const speakerColorDef = useMemo(
    () => resolvePersonaColorDef(message.botId ?? "bot", speakerBot?.color),
    [message.botId, speakerBot?.color],
  );
  const messageContext = (
    <>
      {speakerName ? (
        <div
          className="mb-1.5 flex items-center gap-2 text-body-sm font-semibold tracking-tight"
          dir="auto"
          style={{ color: speakerColorDef.hex }}
        >
          <BotAvatar
            color={speakerBot?.color ?? FALLBACK_BOT_COLOR}
            avatarSet={speakerBot?.avatarSet}
            identity={message.botId}
            size={22}
          />
          {speakerName}
        </div>
      ) : author ? (
        <div
          className="mb-1.5 text-end text-body-sm font-semibold tracking-tight text-muted-foreground"
          dir="auto"
        >
          {author.name}
        </div>
      ) : null}
      <ReplyLine
        target={artifactTarget}
        message={message}
        fallbackText={replyParent ? previewMessageText(replyParent) : undefined}
        author={
          (message.replyPreview?.role ?? replyParent?.role) === "user"
            ? (replyAuthor?.name ?? t`You`)
            : ((replyBotId ? peerBot(replyBotId)?.name : undefined) ??
              memberName?.(replyBotId) ??
              t`Bot`)
        }
        onJump={onJumpToMessage}
      />
    </>
  );
  // Anchored below the speaker and reply line so the rail centers on the bubble itself.
  // A message with text and attachments anchors it on its first text bubble.
  const textAnchorIndex = message.blocks.findIndex((block) => block.kind === "text");
  const hoverAnchorIndex =
    textAnchorIndex === -1
      ? message.blocks.findIndex((block) => block.kind === "ask")
      : textAnchorIndex;
  const peerReceipt = isPeerReceiptBlocks(message.blocks);
  const hoverActions = peerReceipt ? null : (
    <MessageHoverActions
      message={message}
      side={message.role === "user" ? "start" : "end"}
      onReply={onReply}
      onMarkUnread={onMarkUnread}
      markedUnread={markedUnread}
      onReact={onReact}
    />
  );
  if (isNarration) {
    if (visibleNarrationBlocks.length === 0) return null;
    if (isToolOnlyNarration(message.blocks, showToolActivity)) {
      return (
        <>
          {messageContext}
          <div className="relative">
            <ToolOnlyNarration blocks={visibleNarrationBlocks} live={isLive} />
            {hoverActions}
          </div>
        </>
      );
    }
    return (
      <>
        {messageContext}
        <div className="relative w-fit max-w-full [@media(hover:none)]:w-full">
          <div className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full">
            <div
              data-testid="message-bot-bubble"
              className="max-w-full space-y-2.5 rounded-2xl bg-muted px-[18px] py-3 text-body-lg text-foreground"
              dir="auto"
            >
              {visibleNarrationBlocks.map((block, i) => {
                if (block.kind === "steps") {
                  return (
                    <ToolActivityDisclosure
                      key={i}
                      live={isLive}
                      stepCount={toolStepCount(block.steps)}
                      durationMs={block.durationMs}
                    >
                      <ToolSteps
                        steps={block.steps}
                        currentIndex={isLive ? block.steps.length - 1 : undefined}
                        limit={isLive ? LIVE_TOOL_STEP_WINDOW : undefined}
                      />
                    </ToolActivityDisclosure>
                  );
                }
                if (block.kind === "text" || block.kind === "progress") {
                  return (
                    <div
                      key={i}
                      data-quote-message-id={block.kind === "text" ? quoteMessageId : undefined}
                    >
                      <ChatMarkdown
                        streaming={block.kind === "progress"}
                        renderMention={renderMention}
                        onOpenPage={openPage}
                      >
                        {block.text}
                      </ChatMarkdown>
                    </div>
                  );
                }
                return null;
              })}
              {!isLive && voiceReady && message.blocks.some((block) => block.kind === "text") ? (
                <Button
                  variant="text"
                  size="xs"
                  aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                  // Stopping the speech in progress stays available; a call blocks new reads.
                  disabled={callHoldsSpeaker && !speaking}
                  onClick={speak}
                  className="font-normal"
                >
                  {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                </Button>
              ) : null}
            </div>
          </div>
          {hoverActions}
        </div>
        {pageCards}
      </>
    );
  }
  return (
    <>
      {messageContext}
      <div
        className={cn(
          "relative flex flex-col gap-2",
          message.role === "user" && !peerReceipt && "items-end",
        )}
      >
        {blocks.map((block, i) => {
          if (block.kind === "steps" && shouldRenderToolCard(block, showToolActivity)) {
            return (
              <StandaloneToolActivity
                key={i}
                live={isLive}
                steps={block.steps}
                stepCount={toolStepCount(block.steps)}
                durationMs={block.durationMs}
              />
            );
          }
          if (isToolActivityBlock(block)) return null;
          if (block.kind === "handoff") {
            const from = memberName?.(block.fromBotId) ?? t`bot`;
            const to = memberName?.(block.toBotId) ?? t`bot`;
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-body text-muted-foreground"
              >
                <span>
                  ↪ {to} ← {from}
                </span>
                <span>{block.text}</span>
              </div>
            );
          }
          if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
            const sent = block.kind === "bot_message_sent";
            if (
              i !==
              blocks.findIndex(
                (b) => b.kind === "bot_message_sent" || b.kind === "bot_message_received",
              )
            )
              return null;
            const peer = peerExchange?.peerBotName ?? (sent ? block.toBotName : block.fromBotName);
            const peerBotId = sent ? block.toBotId : block.fromBotId;
            const count = peerExchange?.count ?? 1;
            const label =
              count > 1
                ? t`${plural(count, { one: `# message with ${peer}`, other: `# messages with ${peer}` })}`
                : sent
                  ? t`Messaged ${peer}`
                  : t`Message from ${peer}`;
            return (
              <CollaborationMarker
                key={i}
                peerName={peer}
                color={peerBot(peerBotId)?.color ?? FALLBACK_BOT_COLOR}
                avatarSet={peerBot(peerBotId)?.avatarSet}
                identity={peerBotId}
                label={label}
                onClick={() => onOpenPeerMessages({ peerBotId, peerBotName: peer })}
              />
            );
          }
          if (block.kind === "channel_message") {
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-body text-muted-foreground"
              >
                <span className="shrink-0">
                  {messageProviderLabel(block.provider, block.transport)}
                </span>
                <span>
                  {block.fromLabel}: {block.text}
                </span>
              </div>
            );
          }
          if (block.kind === "meta") {
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-body text-muted-foreground"
              >
                <span className="text-warning">◷</span>
                <span>{block.text}</span>
              </div>
            );
          }
          if (block.kind === "progress") {
            return (
              <div
                key={i}
                className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full"
              >
                <div
                  data-testid="message-bot-bubble"
                  className="max-w-full rounded-2xl bg-muted px-[18px] py-3 text-body-lg text-foreground"
                  dir="auto"
                >
                  <ChatMarkdown streaming renderMention={renderMention} onOpenPage={openPage}>
                    {block.text}
                  </ChatMarkdown>
                </div>
              </div>
            );
          }
          if (block.kind === "subagent") {
            const { botId } = message;
            // A saved running card is a background helper's; a live one belongs to this turn.
            const onStop =
              botId && !message.id.startsWith("subagent:")
                ? () => rpc.threads.stopHelper({ botId, messageId: message.id })
                : undefined;
            return <SubagentCard key={i} block={block} onStop={onStop} />;
          }
          if (block.kind === "child_bot") {
            return (
              <div key={i} className="flex items-center gap-1.5 text-body-lg">
                <BotMention
                  block={block}
                  color={peerBot(block.botId)?.color}
                  avatarSet={peerBot(block.botId)?.avatarSet}
                  onOpenBot={onOpenBot}
                />
                {block.status === "created" ? null : (
                  <span className="text-muted-foreground">
                    {block.status === "archived" ? <Trans>archived</Trans> : <Trans>deleted</Trans>}
                  </span>
                )}
              </div>
            );
          }
          if (block.kind === "choice") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return <ChoiceCard key={i} botId={botId} block={block} onBotChanged={onBotChanged} />;
          }
          if (block.kind === "app_connect") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return (
              <div key={i} className="flex justify-start">
                <AppConnectCard
                  botId={botId}
                  threadId={message.threadId}
                  messageId={message.id}
                  block={block}
                />
              </div>
            );
          }
          if (block.kind === "page") {
            return (
              <PageBlockCard
                key={i}
                block={block}
                updated={isPageSuperseded?.(message.id, block) ?? false}
              />
            );
          }
          if (block.kind === "chart") {
            return (
              <div key={i} className="flex justify-start">
                <ChartBlockView name={block.name} spec={block.spec} data={block.data} />
              </div>
            );
          }
          if (block.kind === "app") {
            return (
              <div key={i} className="flex justify-start">
                <McpAppCard block={block} target={artifactTarget} />
              </div>
            );
          }
          if (block.kind === "import_setup") {
            return (
              <div key={i} className="flex justify-start">
                <ImportSetupCard
                  botId={"botId" in artifactTarget ? artifactTarget.botId : message.botId}
                  block={block}
                  onOpen={onOpenImportSetup}
                />
              </div>
            );
          }
          if (block.kind === "mcp_approval") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return (
              <div key={i} className="flex justify-start">
                <McpApprovalCard botId={botId} threadId={message.threadId} block={block} />
              </div>
            );
          }
          if (block.kind === "image") {
            return (
              <div
                key={i}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <ArtifactImage
                  target={artifactTarget}
                  artifactId={block.artifactId}
                  name={block.name}
                />
              </div>
            );
          }
          if (block.kind === "file") {
            return (
              <div
                key={i}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <ArtifactFileCard
                  target={artifactTarget}
                  artifactId={block.artifactId}
                  name={block.name}
                  mimeType={block.mimeType}
                  size={block.size}
                />
              </div>
            );
          }
          if (block.kind === "text" && message.role === "user") {
            // User bubbles stay literal text on web and mobile. Only explicit URLs,
            // email addresses and page links are links, so a sent address is tappable
            // without formatting bold or headings.
            return (
              <div
                key={i}
                className="relative flex w-fit max-w-full justify-end [@media(hover:none)]:w-full [@media(hover:none)]:flex-wrap"
              >
                <div
                  data-testid="message-user-bubble"
                  data-quote-message-id={quoteMessageId}
                  className={cn(
                    "max-w-full whitespace-pre-wrap wrap-anywhere rounded-2xl px-[18px] py-3 text-body-lg",
                    author
                      ? "bg-muted text-foreground/90"
                      : "bg-chat-user text-chat-user-foreground",
                  )}
                  dir="auto"
                >
                  <LinkifiedText onOpenPage={openPage}>{block.text}</LinkifiedText>
                </div>
                {i === hoverAnchorIndex ? hoverActions : null}
              </div>
            );
          }
          if (block.kind === "text") {
            return (
              <div
                key={i}
                className="relative flex w-fit max-w-full justify-start [@media(hover:none)]:w-full [@media(hover:none)]:flex-wrap"
              >
                <div
                  data-testid="message-bot-bubble"
                  className="max-w-full rounded-2xl bg-muted px-[18px] py-3 text-body-lg text-foreground"
                  dir="auto"
                >
                  <div data-quote-message-id={quoteMessageId}>
                    <ChatMarkdown renderMention={renderMention} onOpenPage={openPage}>
                      {block.text}
                    </ChatMarkdown>
                  </div>
                  {voiceReady ? (
                    <Button
                      variant="text"
                      size="xs"
                      aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                      // Stopping the speech in progress stays available; a call blocks new reads.
                      disabled={callHoldsSpeaker && !speaking}
                      onClick={speak}
                      className="mt-2 font-normal"
                    >
                      {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                    </Button>
                  ) : null}
                </div>
                {i === hoverAnchorIndex ? hoverActions : null}
              </div>
            );
          }
          if (block.kind === "card") {
            return (
              <div key={i} className="flex justify-start">
                <div className="flex flex-col gap-2 rounded-2xl bg-muted px-5 py-4">
                  {block.lines.map((line) => (
                    <div key={line.k} className="flex items-baseline gap-2.5 text-body-lg">
                      <span className="text-success">✓</span>
                      <span className="font-semibold text-foreground">{line.k}</span>
                      <span className="text-muted-foreground">→</span>
                      <span>{line.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (block.kind === "ask") {
            return (
              <div key={i} className="relative w-full min-w-0">
                <AskCard
                  block={block}
                  answerIsSeparate={separateAnswers?.has(block)}
                  canAnswer={canAnswer}
                  canDismiss={canDismiss}
                  onAnswer={(text, fields, remember) =>
                    onAnswer(message, text, fields, undefined, remember)
                  }
                  onDismiss={() => onAnswer(message, "", undefined, true)}
                  rpc={rpc}
                />
                {i === hoverAnchorIndex ? hoverActions : null}
              </div>
            );
          }
          if (block.kind === "cloud_agent") return <CloudAgentCard key={i} block={block} />;
          if (block.kind === "skill_draft") {
            return (
              <div key={i} className="flex justify-start">
                <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
              </div>
            );
          }
          if (block.kind === "computer") {
            return (
              <ComputerCard
                key={i}
                block={block}
                botId={message.botId}
                runId={message.runId}
                onOpen={onOpenComputer}
                onRelease={onReleaseComputer}
              />
            );
          }
          return null;
        })}
        {hoverAnchorIndex === -1 ? hoverActions : null}
      </div>
      {pageCards}
    </>
  );
});

/** A bot named inline in its color. A deleted, archived, or missing bot keeps only its name. */
function BotMention({
  block,
  color,
  avatarSet,
  onOpenBot,
}: {
  block: ChildBotBlock;
  color: string | undefined;
  avatarSet?: BotAvatarSet;
  onOpenBot: (botId: string) => void;
}) {
  const live = block.status === "created" && color;
  const name = (
    <span
      dir="auto"
      className="font-medium"
      style={live ? { color: resolvePersonaColorDef(block.botId, color).hex } : undefined}
    >
      {block.name}
    </span>
  );
  if (!live) {
    return (
      <span data-testid="bot-mention" className="inline-flex items-baseline gap-1.5">
        <UserRound className="size-4 self-center text-muted-foreground" aria-hidden="true" />
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="bot-mention"
      onClick={() => onOpenBot(block.botId)}
      className="-mx-1 inline-flex items-baseline gap-1.5 rounded-md px-1 transition-colors hover:bg-accent"
    >
      <span className="self-center">
        <BotAvatar avatarSet={avatarSet} color={color} identity={block.botId} size={18} />
      </span>
      {name}
    </button>
  );
}
