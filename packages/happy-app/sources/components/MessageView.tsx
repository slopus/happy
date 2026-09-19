import * as React from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage, isOtherParticipantMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { AgentEvent, SessionAuthor } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { useSetting } from '@/sync/storage';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { Typography } from '@/constants/Typography';
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';
import { resolveUserMessageBubbleColor } from '@/utils/userMessageBubbleColor';
import { LongPressCopyable } from './LongPressCopyable';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  copyText?: string;
}) => {
  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={Platform.OS !== 'web'}
    >
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          copyText={props.copyText}
        />
      </View>
    </View>
  );
});

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  copyText?: string;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
        />
      );

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} copyText={props.copyText} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

/**
 * The frame every user message sits in. While a message is pending the agent
 * has not read it yet; the chat keeps it at the bottom until then, letting the
 * turn it interrupted finish streaming above it. Busy sends are labelled at
 * once; idle/new-chat sends stay quiet through a grace period and only show a
 * status if acceptance is actually taking time.
 *
 * A message from another participant of a shared session sits on the left,
 * the side that is not "you", with the sender's name above it, like desktop.
 */
function UserMessageFrame(props: {
  pending?: boolean;
  queuedWhileBusy?: boolean;
  createdAt: number;
  sendError?: string;
  author?: SessionAuthor;
  children: React.ReactNode;
}) {
  const fromOther = isOtherParticipantMessage(props);
  const showPendingStatus = usePendingStatusVisible(props.pending, props.queuedWhileBusy, props.createdAt);
  // The tree here must keep the same shape in both states. Settling flips
  // `pending` while the row is on screen, and a structural change — a wrapper
  // that exists in one state only, or a different component type — makes React
  // remount the bubble and its markdown, which shows up as a relayout flash at
  // the exact moment the message should simply stop looking dimmed. Only style
  // values and the trailing status line may differ.
  return (
    <View style={[styles.userMessageContainer, fromOther && styles.userMessageContainerOther]}>
      {fromOther ? <Text numberOfLines={1} style={styles.userMessageAuthorText}>{props.author!.name}</Text> : null}
      {/* collapsable={false}: Fabric materialises a native view for opacity != 1
          and may flatten it away at 1 — settling would then reparent the native
          subtree even though the React tree is stable. Pin the view instead. */}
      <View
        collapsable={false}
        style={[
          styles.userMessageBody,
          fromOther && styles.userMessageBodyOther,
          showPendingStatus && styles.userMessageBodyPending,
        ]}
      >
        {props.children}
      </View>
      {showPendingStatus ? (
        <Text style={styles.pendingStatusText}>
          {props.queuedWhileBusy === true ? t('message.sendsAfterThisTurn') : t('message.sending')}
        </Text>
      ) : null}
      {props.sendError !== undefined ? (
        <Text style={[styles.pendingStatusText, styles.sendErrorText]}>{t('message.sendFailed', { reason: props.sendError })}</Text>
      ) : null}
    </View>
  );
}

// Fast acknowledgements should feel instantaneous. If an idle/new-chat send is
// genuinely taking time, surface that after a short grace period instead of
// leaving a pending message with no explanation. Use createdAt so remounting an
// already-stale row shows its state immediately rather than restarting the wait.
const PENDING_STATUS_GRACE_MS = 1_000;

function usePendingStatusVisible(pending: boolean | undefined, queuedWhileBusy: boolean | undefined, createdAt: number) {
  const shouldDelay = pending === true && queuedWhileBusy !== true;
  const [graceElapsed, setGraceElapsed] = React.useState(
    () => shouldDelay && Date.now() - createdAt >= PENDING_STATUS_GRACE_MS,
  );

  React.useEffect(() => {
    if (!shouldDelay) {
      setGraceElapsed(false);
      return;
    }
    const remaining = PENDING_STATUS_GRACE_MS - (Date.now() - createdAt);
    if (remaining <= 0) {
      setGraceElapsed(true);
      return;
    }
    setGraceElapsed(false);
    const timeout = setTimeout(() => setGraceElapsed(true), remaining);
    return () => clearTimeout(timeout);
  }, [createdAt, shouldDelay]);

  return pending === true && (queuedWhileBusy === true || graceElapsed);
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  const userMessageBubbleColor = useSetting('userMessageBubbleColor');
  const { theme } = useUnistyles();
  const bubblePalette = resolveUserMessageBubbleColor(userMessageBubbleColor, theme.dark);
  const bubbleStyle = {
    backgroundColor: bubblePalette.background,
    borderColor: bubblePalette.border,
  };
  const copyTargetStyle = isOtherParticipantMessage(props.message)
    ? styles.userCopyTargetOther
    : styles.userCopyTarget;
  // Claude Agent SDK emits synthetic user messages wrapped in tags like
  // <local-command-caveat>…</local-command-caveat> and
  // <command-message>…</command-message><command-name>/foo</command-name>
  // whenever a slash command runs. The plain MarkdownView renders these as
  // literal text, which looks broken. Collapse them into chips or hide
  // them entirely depending on what kind of wrapper this is.
  // The user's own slash-command input is shown optimistically (carries a
  // localId); the SDK then injects the canonical wrapper chip. Hide the raw
  // echo so we don't render the command twice. Gated to Claude flavor only:
  // Codex/Gemini don't reliably emit the <command-*> wrapper, so hiding the
  // echo there would drop the command with nothing to replace it. (Absent
  // flavor == Claude, matching the convention used elsewhere.)
  const isClaudeFlavor = !props.metadata?.flavor || props.metadata.flavor === 'claude';
  if (isClaudeFlavor && isUserSlashCommandEcho(props.message.text, props.message.localId != null)) {
    return null;
  }

  const parsed = parseLocalCommandMessage(props.message.displayText || props.message.text);
  if (parsed.kind === 'caveat') {
    return null;
  }
  if (parsed.kind === 'goal-confirmation') {
    return null;
  }
  if (parsed.kind === 'goal-run') {
    return (
      <UserMessageFrame pending={props.message.pending} queuedWhileBusy={props.message.meta?.queuedWhileBusy} createdAt={props.message.createdAt} sendError={props.message.sendError} author={props.message.author}>
        <LongPressCopyable style={copyTargetStyle} text={parsed.goal}>
          <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle, styles.goalMessageBubble]}>
            <MarkdownView externalCopyHandler markdown={parsed.goal} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
          </View>
          <View style={styles.goalSentRow}>
            <Ionicons name="locate-outline" size={16} color={styles.goalSentText.color} />
            <Text style={styles.goalSentText}>{t('message.sentAsGoal')}</Text>
          </View>
        </LongPressCopyable>
      </UserMessageFrame>
    );
  }
  if (parsed.kind === 'command-run') {
    const commandText = parsed.args ? `/${parsed.commandName} ${parsed.args}` : `/${parsed.commandName}`;
    return (
      <UserMessageFrame pending={props.message.pending} queuedWhileBusy={props.message.meta?.queuedWhileBusy} createdAt={props.message.createdAt} sendError={props.message.sendError} author={props.message.author}>
        <LongPressCopyable style={copyTargetStyle} text={commandText}>
          {parsed.args ? (
            <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle, styles.commandMessageBubble]}>
              <MarkdownView externalCopyHandler markdown={parsed.args} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
            </View>
          ) : null}
          <View style={[styles.commandChip, styles.userMessageBubbleSolid, bubbleStyle]}>
            <Text style={styles.commandChipText}>/{parsed.commandName}</Text>
          </View>
        </LongPressCopyable>
      </UserMessageFrame>
    );
  }

  return (
    <UserMessageFrame pending={props.message.pending} queuedWhileBusy={props.message.meta?.queuedWhileBusy} createdAt={props.message.createdAt} sendError={props.message.sendError} author={props.message.author}>
      {/* Long-press copies the whole message through our own menu rather than the
          OS selection callout. Rewind remains in session actions. */}
      <LongPressCopyable style={copyTargetStyle} text={parsed.text}>
        <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle]}>
          <MarkdownView externalCopyHandler markdown={parsed.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
        </View>
      </LongPressCopyable>
    </UserMessageFrame>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  copyText?: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // Hide thinking messages
  if (props.message.isThinking) {
    return null;
  }

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      {props.copyText ? <MessageCopyButton text={props.copyText} /> : null}
    </View>
  );
}

// The glyph is deliberately small, so widen the touch target well past it.
const COPY_HIT_SLOP = { top: 14, bottom: 14, left: 14, right: 20 };

function MessageCopyButton(props: { text: string }) {
  const { theme } = useUnistyles();
  const [copied, setCopied] = React.useState(false);
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
  }, []);

  const handleCopy = React.useCallback(async () => {
    try {
      await Clipboard.setStringAsync(props.text);
      setCopied(true);
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('Failed to copy message:', error);
    }
  }, [props.text]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? t('common.copied') : t('common.copy')}
      hitSlop={COPY_HIT_SLOP}
      onPress={handleCopy}
      style={({ pressed }) => [
        styles.copyAction,
        pressed && styles.copyActionPressed,
      ]}
    >
      <Ionicons
        name={copied ? 'checkmark' : 'copy-outline'}
        size={16}
        color={theme.colors.text}
      />
    </Pressable>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={styles.toolContainer}>
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: layout.maxWidth,
    overflow: 'hidden',
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 4,
    maxWidth: '100%',
  },
  userMessageBubbleSolid: {
    borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
    overflow: 'hidden',
  },
  goalMessageBubble: {
    marginBottom: 6,
  },
  commandMessageBubble: {
    marginBottom: 6,
  },
  goalSentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
    maxWidth: '100%',
    opacity: 0.72,
  },
  goalSentText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  commandChip: {
    backgroundColor: theme.colors.userMessageBackground,
    borderColor: theme.colors.divider,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 10,
    marginBottom: 4,
    maxWidth: '100%',
    opacity: 0.65,
  },
  commandChipText: {
    color: theme.colors.input.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  agentMessageContainer: {
    // Symmetric, so a tool row reads the same distance from the text whether
    // it lands above or below it. Total rhythm matches the old 4 + 16.
    marginHorizontal: 16,
    marginVertical: 10,
    borderRadius: 16,
    maxWidth: '100%',
  },
  copyAction: {
    // No width, so the box shrink-wraps the glyph and its left edge lands on the
    // same x as the markdown text above it. hitSlop carries the touch target.
    alignSelf: 'flex-start',
    height: 20,
    justifyContent: 'center',
    // Sits fully below the last markdown block's trailing margin, clear of the
    // reply text.
    marginTop: 0,
  },
  copyActionPressed: {
    opacity: 0.5,
  },
  userCopyTarget: {
    alignItems: 'flex-end',
    maxWidth: '100%',
  },
  userCopyTargetOther: {
    alignItems: 'flex-start',
    maxWidth: '100%',
  },
  userMessageBody: {
    alignItems: 'flex-end',
    maxWidth: '100%',
  },
  // Another participant's message: everything on the reader's side is on the
  // right, so the other side of the chat is the left, like any messenger.
  userMessageContainerOther: {
    alignItems: 'flex-start',
  },
  userMessageBodyOther: {
    alignItems: 'flex-start',
  },
  userMessageAuthorText: {
    color: theme.colors.text,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
    paddingHorizontal: 12,
    maxWidth: '100%',
    ...Typography.default('semiBold'),
  },
  userMessageBodyPending: {
    // Dimmed rather than greyed: the bubble keeps its own color, so the message
    // reads as the user's own and merely not arrived yet.
    opacity: 0.45,
  },
  pendingStatusText: {
    color: theme.colors.agentEventText,
    // Matches the status line above the composer, the app's other place for
    // saying what the session is doing right now.
    fontSize: 11,
    marginBottom: 4,
    marginTop: 2,
    ...Typography.default(),
  },
  sendErrorText: {
    color: theme.colors.textDestructive,
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  toolContainer: {
    marginHorizontal: 8,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
