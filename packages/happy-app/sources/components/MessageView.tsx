import * as React from "react";
import { View, Text, Pressable, Platform, TextInput } from "react-native";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage, ModeSwitchMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';
import { getAutoFoldPromptBodyRenderState, getAutoFoldPromptInfo } from '@/utils/autoFoldPrompt';
import { ConversationActivityStrip } from './ConversationActivityStrip';
import { getMessageExecutionModeLabel } from '@/utils/messageExecutionMode';
import { DesktopShortcutTooltip } from './DesktopShortcutTooltip';
import type { MessageForkTarget } from '@/utils/messageForkPoint';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  /**
   * Long-press handler for user-text bubbles. Wired by ChatList from
   * the active session screen and used by the fork-from-message flow.
   */
  onForkFromMessage?: (
    messageId: string,
    rewindPointId: string | undefined,
    messageText: string,
    retainSelectedTurn?: boolean,
  ) => void;
  agentForkTarget?: MessageForkTarget;
  showAgentMessageActions?: boolean;
  showUserMessageActions?: boolean;
  canEditUserMessage?: boolean;
  onEditUserMessage?: (messageId: string, messageText: string) => Promise<void> | void;
}) => {
  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={Platform.OS !== 'web'}
    >
      <View
        style={[
          styles.messageContent,
          Platform.OS === 'web' && props.message.kind === 'agent-text' && styles.agentMessageContent,
        ]}
      >
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          onForkFromMessage={props.onForkFromMessage}
          agentForkTarget={props.agentForkTarget}
          showAgentMessageActions={props.showAgentMessageActions}
          showUserMessageActions={props.showUserMessageActions}
          canEditUserMessage={props.canEditUserMessage}
          onEditUserMessage={props.onEditUserMessage}
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
  onForkFromMessage?: (
    messageId: string,
    rewindPointId: string | undefined,
    messageText: string,
    retainSelectedTurn?: boolean,
  ) => void;
  agentForkTarget?: MessageForkTarget;
  showAgentMessageActions?: boolean;
  showUserMessageActions?: boolean;
  canEditUserMessage?: boolean;
  onEditUserMessage?: (messageId: string, messageText: string) => Promise<void> | void;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          onForkFromUserMessage={props.onForkFromMessage}
          showUserMessageActions={props.showUserMessageActions}
          canEditUserMessage={props.canEditUserMessage}
          onEditUserMessage={props.onEditUserMessage}
        />
      );

    case 'agent-text':
      return (
        <AgentTextBlock
          message={props.message}
          sessionId={props.sessionId}
          forkTarget={props.agentForkTarget}
          onForkFromMessage={props.onForkFromMessage}
          showActions={props.showAgentMessageActions}
        />
      );

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return <AgentEventBlock message={props.message} metadata={props.metadata} />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
  showUserMessageActions?: boolean;
  canEditUserMessage?: boolean;
  onEditUserMessage?: (messageId: string, messageText: string) => Promise<void> | void;
}) {
  const { theme } = useUnistyles();
  const [isEditing, setIsEditing] = React.useState(false);
  const [editText, setEditText] = React.useState('');
  const [isSendingEdit, setIsSendingEdit] = React.useState(false);
  const [isCopied, setIsCopied] = React.useState(false);
  const copyFeedbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  const rewindPointId = props.message.claudeUuid ?? props.message.codexItemId;
  const canFork = Boolean(props.onForkFromUserMessage)
    && (Boolean(rewindPointId) || props.metadata?.flavor === 'codex');
  const modeLabel = getMessageExecutionModeLabel(props.message.meta, props.metadata?.flavor, t);
  const handleLongPress = React.useCallback(() => {
    if (props.onForkFromUserMessage) {
      props.onForkFromUserMessage(props.message.id, rewindPointId, props.message.text);
    }
  }, [props.message.id, props.message.text, props.onForkFromUserMessage, rewindPointId]);
  const visibleText = props.message.displayText || props.message.text;
  const showActions = Platform.OS === 'web' && props.showUserMessageActions;
  const canEdit = showActions && props.canEditUserMessage && Boolean(props.onEditUserMessage);
  const startEditing = React.useCallback(() => {
    setEditText(visibleText);
    setIsEditing(true);
  }, [visibleText]);
  const cancelEditing = React.useCallback(() => {
    setEditText('');
    setIsEditing(false);
  }, []);
  const copyMessage = React.useCallback(async () => {
    try {
      await Clipboard.setStringAsync(visibleText);
      setIsCopied(true);
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = setTimeout(() => {
        setIsCopied(false);
        copyFeedbackTimerRef.current = null;
      }, 1800);
    } catch {
      setIsCopied(false);
    }
  }, [visibleText]);
  React.useEffect(() => () => {
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
  }, []);
  const sendEditedMessage = React.useCallback(async () => {
    const trimmed = editText.trim();
    if (!trimmed || !props.onEditUserMessage || isSendingEdit) return;

    setIsSendingEdit(true);
    try {
      await props.onEditUserMessage(props.message.localId ?? props.message.id, trimmed);
      setIsEditing(false);
    } finally {
      setIsSendingEdit(false);
    }
  }, [editText, isSendingEdit, props.message.id, props.message.localId, props.onEditUserMessage]);

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

  const parsed = parseLocalCommandMessage(visibleText);
  if (parsed.kind === 'caveat') {
    return null;
  }
  if (parsed.kind === 'command-run') {
    return (
      <View style={styles.userMessageContainer}>
        <View style={[styles.commandChip, modeLabel && styles.userContentWithModeMeta]}>
          <Text style={styles.commandChipText}>/{parsed.commandName}</Text>
        </View>
        <UserMessageModeLabel messageId={props.message.id} label={modeLabel} />
      </View>
    );
  }

  const autoFoldPrompt = getAutoFoldPromptInfo(parsed.text);
  if (autoFoldPrompt) {
    return (
      <View style={styles.userMessageContainer}>
        <View style={[styles.userAutoFoldWrap, modeLabel && styles.userContentWithModeMeta]}>
          <AutoFoldPromptBlock
            text={parsed.text}
            info={autoFoldPrompt}
            onOptionPress={handleOptionPress}
            sessionId={props.sessionId}
          />
        </View>
        <UserMessageModeLabel messageId={props.message.id} label={modeLabel} />
      </View>
    );
  }

  if (isEditing) {
    const canSend = editText.trim().length > 0 && !isSendingEdit;
    return (
      <View testID={`message-user-${props.message.id}`} style={styles.userMessageContainer}>
        <View style={styles.userMessageEditor}>
          <TextInput
            testID={`message-user-edit-input-${props.message.id}`}
            accessibilityLabel={t('message.editInput')}
            autoFocus
            editable={!isSendingEdit}
            multiline
            onChangeText={setEditText}
            placeholderTextColor={theme.colors.input.placeholder}
            selectionColor={theme.colors.textLink}
            style={styles.userMessageEditorInput}
            value={editText}
          />
          <View style={styles.userMessageEditorActions}>
            <Pressable
              testID={`message-user-edit-cancel-${props.message.id}`}
              accessibilityLabel={t('common.cancel')}
              accessibilityRole="button"
              disabled={isSendingEdit}
              onPress={cancelEditing}
              style={({ pressed }) => [styles.userMessageEditorButton, pressed && styles.userMessageActionPressed]}
            >
              <Text style={styles.userMessageEditorCancelText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              testID={`message-user-edit-send-${props.message.id}`}
              accessibilityLabel={t('message.sendEdit')}
              accessibilityRole="button"
              disabled={!canSend}
              onPress={() => { void sendEditedMessage(); }}
              style={({ pressed }) => [
                styles.userMessageEditorButton,
                styles.userMessageEditorSendButton,
                !canSend && styles.userMessageEditorSendButtonDisabled,
                pressed && canSend && styles.userMessageActionPressed,
              ]}
            >
              <Text style={styles.userMessageEditorSendText}>{t('message.sendEdit')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View testID={`message-user-${props.message.id}`} style={styles.userMessageContainer}>
      <Pressable
        onLongPress={canFork ? handleLongPress : undefined}
        delayLongPress={400}
        style={[
          styles.userMessageBubble,
          (modeLabel || showActions) && styles.userContentWithModeMeta,
        ]}
      >
        <MarkdownView markdown={parsed.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      </Pressable>
      {showActions && (
        <View style={[styles.userMessageActions, modeLabel && styles.userMessageActionsWithMode]}>
          <Pressable
            testID={`message-user-copy-${props.message.id}`}
            accessibilityLabel={isCopied ? t('common.copied') : t('common.copy')}
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => { void copyMessage(); }}
            style={({ pressed }) => [
              styles.userMessageAction,
              isCopied && styles.userMessageCopyActionCopied,
              pressed && styles.userMessageActionPressed,
            ]}
          >
            <Ionicons
              name={isCopied ? 'checkmark' : 'copy-outline'}
              size={16}
              color={isCopied ? theme.colors.success : theme.colors.textSecondary}
            />
            {isCopied && (
              <Text
                testID={`message-user-copy-feedback-${props.message.id}`}
                accessibilityLiveRegion="polite"
                style={styles.userMessageCopyFeedbackText}
              >
                {t('common.copied')}
              </Text>
            )}
          </Pressable>
          {canEdit && (
            <Pressable
              testID={`message-user-edit-${props.message.id}`}
              accessibilityLabel={t('message.editInput')}
              accessibilityRole="button"
              hitSlop={6}
              onPress={startEditing}
              style={({ pressed }) => [styles.userMessageAction, pressed && styles.userMessageActionPressed]}
            >
              <Ionicons name="pencil-outline" size={16} color={theme.colors.textSecondary} />
            </Pressable>
          )}
        </View>
      )}
      <UserMessageModeLabel messageId={props.message.id} label={modeLabel} />
    </View>
  );
}

function UserMessageModeLabel(props: { messageId: string; label: string | null }) {
  if (!props.label) {
    return null;
  }

  return (
    <Text testID={`message-user-mode-${props.messageId}`} style={styles.userMessageModeText} numberOfLines={1}>
      {props.label}
    </Text>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  forkTarget?: MessageForkTarget;
  onForkFromMessage?: (
    messageId: string,
    rewindPointId: string | undefined,
    messageText: string,
    retainSelectedTurn?: boolean,
  ) => void;
  showActions?: boolean;
}) {
  const { theme } = useUnistyles();
  const [isHovered, setIsHovered] = React.useState(false);
  const [isActionFocused, setIsActionFocused] = React.useState(false);
  const [hoveredAction, setHoveredAction] = React.useState<'copy' | 'fork' | null>(null);
  const [isCopied, setIsCopied] = React.useState(false);
  const copyFeedbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);
  const copyMessage = React.useCallback(async () => {
    try {
      await Clipboard.setStringAsync(props.message.text);
      setIsCopied(true);
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = setTimeout(() => {
        setIsCopied(false);
        copyFeedbackTimerRef.current = null;
      }, 1800);
    } catch {
      setIsCopied(false);
    }
  }, [props.message.text]);
  React.useEffect(() => () => {
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
  }, []);

  // Hide thinking messages
  if (props.message.isThinking) {
    return null;
  }

  const showActions = Platform.OS === 'web' && props.showActions;
  const canFork = Boolean(props.forkTarget && props.onForkFromMessage);
  const actionsVisible = Boolean(showActions && (isHovered || isActionFocused || isCopied));
  const handleFork = () => {
    if (!props.forkTarget || !props.onForkFromMessage) return;
    props.onForkFromMessage(
      props.forkTarget.messageId,
      props.forkTarget.rewindPointId,
      props.forkTarget.messageText,
      true,
    );
  };

  const autoFoldPrompt = getAutoFoldPromptInfo(props.message.text);
  if (autoFoldPrompt) {
    return (
      <View style={styles.agentMessageContainer}>
        <AutoFoldPromptBlock
          text={props.message.text}
          info={autoFoldPrompt}
          onOptionPress={handleOptionPress}
          sessionId={props.sessionId}
        />
      </View>
    );
  }

  return (
    <View
      testID={`message-agent-${props.message.id}`}
      style={styles.agentMessageContainer}
      {...(Platform.OS === 'web' ? ({
        onMouseEnter: () => setIsHovered(true),
        onMouseLeave: () => setIsHovered(false),
      } as any) : {})}
    >
      <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      {showActions && (
        <View
          testID={`message-agent-actions-${props.message.id}`}
          pointerEvents={actionsVisible ? 'auto' : 'none'}
          style={[styles.agentMessageActions, actionsVisible && styles.agentMessageActionsVisible]}
        >
          <View style={styles.agentMessageActionSlot}>
            <Pressable
              testID={`message-agent-copy-${props.message.id}`}
              accessibilityLabel={isCopied ? t('common.copied') : t('common.copy')}
              accessibilityLiveRegion="polite"
              accessibilityRole="button"
              hitSlop={6}
              onBlur={() => { setIsActionFocused(false); setHoveredAction(null); }}
              onFocus={() => { setIsActionFocused(true); setHoveredAction('copy'); }}
              onHoverIn={() => setHoveredAction('copy')}
              onHoverOut={() => setHoveredAction(null)}
              onPress={() => { void copyMessage(); }}
              style={({ pressed }) => [
                styles.agentMessageAction,
                hoveredAction === 'copy' && styles.agentMessageActionHovered,
                pressed && styles.agentMessageActionPressed,
              ]}
            >
              <Ionicons
                name={isCopied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={isCopied ? theme.colors.success : theme.colors.textSecondary}
              />
            </Pressable>
            <DesktopShortcutTooltip
              compact
              label={isCopied ? t('common.copied') : t('common.copy')}
              placement="above"
              testID={`message-agent-copy-tooltip-${props.message.id}`}
              visible={actionsVisible && hoveredAction === 'copy'}
            />
          </View>
          {canFork && (
            <View style={styles.agentMessageActionSlot}>
              <Pressable
                testID={`message-agent-fork-${props.message.id}`}
                accessibilityLabel={t('session.forkFromHere')}
                accessibilityRole="button"
                hitSlop={6}
                onBlur={() => { setIsActionFocused(false); setHoveredAction(null); }}
                onFocus={() => { setIsActionFocused(true); setHoveredAction('fork'); }}
                onHoverIn={() => setHoveredAction('fork')}
                onHoverOut={() => setHoveredAction(null)}
                onPress={handleFork}
                style={({ pressed }) => [
                  styles.agentMessageAction,
                  hoveredAction === 'fork' && styles.agentMessageActionHovered,
                  pressed && styles.agentMessageActionPressed,
                ]}
              >
                <Ionicons name="git-branch-outline" size={16} color={theme.colors.textSecondary} />
              </Pressable>
              <DesktopShortcutTooltip
                compact
                label={t('session.forkFromHere')}
                placement="above"
                testID={`message-agent-fork-tooltip-${props.message.id}`}
                visible={actionsVisible && hoveredAction === 'fork'}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function AutoFoldPromptBlock(props: {
  text: string;
  info: NonNullable<ReturnType<typeof getAutoFoldPromptInfo>>;
  onOptionPress: (option: Option) => void;
  sessionId: string;
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const toggleExpanded = React.useCallback(() => {
    setExpanded((value) => !value);
  }, []);
  const copyPrompt = React.useCallback(() => {
    void Clipboard.setStringAsync(props.text);
  }, [props.text]);
  const bodyRenderState = getAutoFoldPromptBodyRenderState({
    text: props.text,
    info: props.info,
    expanded,
  });

  return (
    <View style={styles.autoFoldCard}>
      <View style={styles.autoFoldHeader}>
        <Pressable style={styles.autoFoldHeaderMain} onPress={toggleExpanded}>
          <Ionicons name="document-text-outline" size={17} color={theme.colors.textSecondary} />
          <View style={styles.autoFoldTitleGroup}>
            <Text style={styles.autoFoldTitle} numberOfLines={1}>{t('message.foldedPromptTitle')}</Text>
            <Text style={styles.autoFoldSummary} numberOfLines={1}>
              {t('message.foldedPromptSummary', { lines: props.info.lineCount, chars: props.info.charCount })}
            </Text>
          </View>
        </Pressable>
        <Pressable style={styles.autoFoldAction} onPress={copyPrompt}>
          <Ionicons name="copy-outline" size={16} color={theme.colors.textSecondary} />
          <Text style={styles.autoFoldActionText}>{t('common.copy')}</Text>
        </Pressable>
        <Pressable style={styles.autoFoldAction} onPress={toggleExpanded}>
          <Text style={styles.autoFoldActionText}>{expanded ? t('message.hidePrompt') : t('message.showPrompt')}</Text>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textSecondary} />
        </Pressable>
      </View>
      <View style={styles.autoFoldBody}>
        {bodyRenderState.kind === 'markdown' ? (
          <MarkdownView
            markdown={bodyRenderState.text}
            onOptionPress={props.onOptionPress}
            sessionId={props.sessionId}
            variant={bodyRenderState.markdownVariant}
          />
        ) : (
          <Text style={styles.autoFoldBodyText}>{bodyRenderState.text}</Text>
        )}
      </View>
    </View>
  );
}

function AgentEventBlock(props: {
  message: ModeSwitchMessage;
  metadata: Metadata | null;
}) {
  const { event } = props.message;
  if (event.type === 'subagent-status') {
    return <ConversationActivityStrip messages={[props.message]} />;
  }
  if (event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: event.mode })}</Text>
      </View>
    );
  }
  if (event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{event.message}</Text>
      </View>
    );
  }
  if (event.type === 'limit-reached') {
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
          {t('message.usageLimitUntil', { time: formatTime(event.endsAt) })}
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
  agentMessageContent: {
    overflow: 'visible',
    zIndex: 1,
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
    marginBottom: 12,
    maxWidth: '100%',
  },
  userContentWithModeMeta: {
    marginBottom: 4,
  },
  userMessageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginBottom: 12,
    paddingHorizontal: 2,
  },
  userMessageActionsWithMode: {
    marginBottom: 2,
  },
  userMessageAction: {
    width: 28,
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  userMessageCopyActionCopied: {
    width: 'auto',
    gap: 4,
    paddingHorizontal: 7,
  },
  userMessageCopyFeedbackText: {
    color: theme.colors.success,
    fontSize: 12,
    fontWeight: '600',
  },
  userMessageActionPressed: {
    opacity: 0.58,
  },
  userMessageEditor: {
    width: '88%',
    minWidth: 320,
    maxWidth: 900,
    minHeight: 156,
    marginBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderRadius: 20,
    backgroundColor: theme.colors.userMessageBackground,
  },
  userMessageEditorInput: {
    flex: 1,
    minHeight: 88,
    padding: 0,
    color: theme.colors.input.text,
    fontSize: 16,
    lineHeight: 23,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as any,
  userMessageEditorActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  userMessageEditorButton: {
    minWidth: 64,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.divider,
  },
  userMessageEditorCancelText: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  userMessageEditorSendButton: {
    borderColor: theme.colors.text,
    backgroundColor: theme.colors.text,
  },
  userMessageEditorSendButtonDisabled: {
    opacity: 0.45,
  },
  userMessageEditorSendText: {
    color: theme.colors.surface,
    fontSize: 15,
    fontWeight: '600',
  },
  userMessageModeText: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  commandChip: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 10,
    marginBottom: 12,
    maxWidth: '100%',
    opacity: 0.65,
  },
  commandChipText: {
    color: theme.colors.input.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  userAutoFoldWrap: {
    width: '100%',
    maxWidth: 520,
    marginBottom: 12,
  },
  agentMessageContainer: {
    position: 'relative',
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    maxWidth: '100%',
  },
  agentMessageActions: {
    position: 'absolute',
    left: 0,
    bottom: -30,
    zIndex: 30,
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 2,
    opacity: 0,
  },
  agentMessageActionsVisible: {
    opacity: 1,
  },
  agentMessageActionSlot: {
    position: 'relative',
    width: 28,
    height: 28,
    zIndex: 20,
  },
  agentMessageAction: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  agentMessageActionHovered: {
    backgroundColor: theme.colors.surfacePressed,
  },
  agentMessageActionPressed: {
    backgroundColor: theme.colors.surfaceSelected,
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
  autoFoldCard: {
    backgroundColor: theme.colors.surfaceHigh,
    borderColor: theme.colors.divider,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  autoFoldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomColor: theme.colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  autoFoldHeaderMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  autoFoldTitleGroup: {
    flex: 1,
    minWidth: 0,
  },
  autoFoldTitle: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  autoFoldSummary: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 1,
  },
  autoFoldAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
  },
  autoFoldActionText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  autoFoldBodyText: {
    color: theme.colors.textSecondary,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    lineHeight: 18,
  },
  autoFoldBody: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
