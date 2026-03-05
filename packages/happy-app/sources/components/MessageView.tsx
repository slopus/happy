import * as React from "react";
import { createPortal } from "react-dom";
import { View, Text, Pressable, Linking, Platform, Modal } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { layout } from "./layout";
import { useContentMaxWidth } from "./SidebarNavigator";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { storage, useSession, useSetting } from "@/sync/storage";
import * as Clipboard from 'expo-clipboard';

// Strip <options> blocks and other technical markup from text for copy/share
function cleanTextForShare(text: string): string {
  return text
    .replace(/<options>[\s\S]*?<\/options>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  onRegenerate?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => void;
}) => {
  const expandedMaxWidth = useContentMaxWidth();
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={expandedMaxWidth ? [styles.messageContent, { maxWidth: expandedMaxWidth }] : styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          onRegenerate={props.onRegenerate}
          onDelete={props.onDelete}
          onEdit={props.onEdit}
        />
      </View>
    </View>
  );
};

// Format timestamp for display
function formatMessageTime(createdAt: number): string {
  const date = new Date(createdAt);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  if (isYesterday) return `вчера ${time}`;
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  onRegenerate?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => void;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return <UserTextBlock message={props.message} sessionId={props.sessionId} onRegenerate={props.onRegenerate} onDelete={props.onDelete} onEdit={props.onEdit} />;

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} onRegenerate={props.onRegenerate} onDelete={props.onDelete} />;

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

function UserTextBlock(props: {
  message: UserTextMessage;
  sessionId: string;
  onRegenerate?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => void;
}) {
  const [previewImage, setPreviewImage] = React.useState<string | null>(null);
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title);
  }, [props.sessionId]);

  const handleImagePress = React.useCallback((url: string) => {
    setPreviewImage(url);
  }, []);

  const handleEdit = React.useCallback(() => {
    props.onEdit?.(props.message.id, props.message.text);
  }, [props.onEdit, props.message.id, props.message.text]);

  const handleRegenerate = React.useCallback(() => {
    props.onRegenerate?.(props.message.id);
  }, [props.onRegenerate, props.message.id]);

  const handleDelete = React.useCallback(() => {
    props.onDelete?.(props.message.id);
  }, [props.onDelete, props.message.id]);

  const showText = props.message.text && props.message.text !== '[image]' && props.message.text !== '[document]';
  const sentVia = props.message.meta?.sentVia;

  return (
    <View style={styles.userMessageContainer}>
      <View>
        <View style={styles.userMessageBubble}>
          {props.message.images && props.message.images.length > 0 && (
            <View style={styles.userImagesContainer}>
              {props.message.images.map((img, i) => {
                const aspect = img.width / img.height;
                const displayWidth = Math.min(260, img.width);
                const displayHeight = displayWidth / aspect;
                return (
                  <Pressable key={i} onPress={() => handleImagePress(img.url)}>
                    <Image
                      source={{ uri: img.url }}
                      style={{
                        width: displayWidth,
                        height: displayHeight,
                        borderRadius: 8,
                      }}
                      contentFit="cover"
                      transition={200}
                    />
                  </Pressable>
                );
              })}
            </View>
          )}
          {props.message.documents && props.message.documents.length > 0 && (
            <View style={styles.userDocumentsContainer}>
              {props.message.documents.map((doc, i) => (
                <Pressable
                  key={i}
                  style={styles.documentChip}
                  onPress={() => {
                    if (Platform.OS === 'web') {
                      window.open(doc.url, '_blank');
                    } else {
                      Linking.openURL(doc.url);
                    }
                  }}
                >
                  <Ionicons name="document-text-outline" size={20} color={styles.documentName.color as string} />
                  <View style={{ flexShrink: 1 }}>
                    <Text style={styles.documentName} numberOfLines={1}>{doc.fileName}</Text>
                    <Text style={styles.documentSize}>{formatFileSize(doc.fileSize)}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}
          {showText && (
            <MarkdownView markdown={props.message.displayText || props.message.text} onOptionPress={handleOptionPress} />
          )}
        </View>
      </View>
      {/* Timestamp + actions row - always visible */}
      <View style={styles.userMessageMeta}>
        <View style={styles.messageActions}>
          {props.onEdit && showText && (
            <Pressable onPress={handleEdit} style={({ pressed }) => [styles.messageActionButton, pressed && { opacity: 0.5 }]} hitSlop={8}>
              <Ionicons name="pencil-outline" size={14} color={styles.messageActionIcon.color as string} />
            </Pressable>
          )}
          {props.onRegenerate && (
            <Pressable onPress={handleRegenerate} style={({ pressed }) => [styles.messageActionButton, pressed && { opacity: 0.5 }]} hitSlop={8}>
              <Ionicons name="refresh-outline" size={14} color={styles.messageActionIcon.color as string} />
            </Pressable>
          )}
          {props.onDelete && (
            <Pressable onPress={handleDelete} style={({ pressed }) => [styles.messageActionButton, pressed && { opacity: 0.5 }]} hitSlop={8}>
              <Ionicons name="trash-outline" size={14} color={styles.messageActionIcon.color as string} />
            </Pressable>
          )}
        </View>
        <Text style={styles.timestampText}>{formatMessageTime(props.message.createdAt)}</Text>
      </View>
      {sentVia && (
        <View style={styles.voiceBadge}>
          <Text style={styles.voiceBadgeText}>
            {sentVia === 'siri' ? '🎙 Siri' : '🎙'}
          </Text>
        </View>
      )}
      {previewImage && Platform.OS !== 'web' && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setPreviewImage(null)}>
          <Pressable
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' }}
            onPress={() => setPreviewImage(null)}
          >
            <Image
              source={{ uri: previewImage }}
              style={{ width: '90%', height: '80%' }}
              contentFit="contain"
            />
          </Pressable>
        </Modal>
      )}
      {previewImage && Platform.OS === 'web' && createPortal(
        <div
          onClick={() => setPreviewImage(null)}
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.92)',
            zIndex: 99999,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={previewImage}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '92%',
              maxHeight: '90%',
              objectFit: 'contain',
              borderRadius: 8,
              cursor: 'default',
            }}
          />
        </div>,
        document.body
      )}
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  onRegenerate?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
}) {
  const experiments = useSetting('experiments');
  const [copied, setCopied] = React.useState(false);
  const [showActions, setShowActions] = React.useState(false);
  const lastTapRef = React.useRef(0);
  const handleDoubleTap = React.useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      setShowActions(v => !v);
    }
    lastTapRef.current = now;
  }, []);
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title);
  }, [props.sessionId]);

  const handleFilePathPress = React.useCallback((filePath: string) => {
    storage.getState().setPreviewState(props.sessionId, { url: filePath, isVisible: true });
  }, [props.sessionId]);

  const handleCopy = React.useCallback(async () => {
    try {
      await Clipboard.setStringAsync(cleanTextForShare(props.message.text));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  }, [props.message.text]);

  const handleRegenerate = React.useCallback(() => {
    setShowActions(false);
    props.onRegenerate?.(props.message.id);
  }, [props.onRegenerate, props.message.id]);

  const handleDelete = React.useCallback(() => {
    setShowActions(false);
    props.onDelete?.(props.message.id);
  }, [props.onDelete, props.message.id]);

  // Hide thinking messages unless experiments is enabled
  if (props.message.isThinking && !experiments) {
    return null;
  }

  return (
    <Pressable onPress={handleDoubleTap}>
      <View style={styles.agentMessageContainer}>
        <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} onFilePathPress={handleFilePathPress} />
        {props.message.text.length > 0 && !props.message.isThinking && (
          <View style={styles.messageActionsRow}>
            {showActions ? (
              <View style={styles.messageActions}>
                <Pressable
                  onPress={handleCopy}
                  style={({ pressed }) => [styles.messageActionButton, pressed && { opacity: 0.5 }]}
                  hitSlop={8}
                >
                  <Ionicons name={copied ? "checkmark" : "copy-outline"} size={15} color={styles.messageActionIcon.color as string} />
                </Pressable>
                {props.onRegenerate && (
                  <Pressable
                    onPress={handleRegenerate}
                    style={({ pressed }) => [styles.messageActionButton, pressed && { opacity: 0.5 }]}
                    hitSlop={8}
                  >
                    <Ionicons name="refresh-outline" size={15} color={styles.messageActionIcon.color as string} />
                  </Pressable>
                )}
                {props.onDelete && (
                  <Pressable
                    onPress={handleDelete}
                    style={({ pressed }) => [styles.messageActionButton, pressed && { opacity: 0.5 }]}
                    hitSlop={8}
                  >
                    <Ionicons name="trash-outline" size={14} color={styles.messageActionIcon.color as string} />
                  </Pressable>
                )}
              </View>
            ) : (
              <View style={styles.messageActions} />
            )}
            <Text style={styles.timestampText}>{formatMessageTime(props.message.createdAt)}</Text>
          </View>
        )}
      </View>
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
  const session = useSession(props.sessionId);
  if (!props.message.tool) {
    return null;
  }
  // Zen mode: hide all tool call blocks
  if (session?.permissionMode === 'zen') {
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
    marginBottom: 12,
    maxWidth: '100%',
    ...(Platform.OS === 'web' ? { wordBreak: 'break-word' as any, overflowWrap: 'break-word' as any } : {}),
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    alignSelf: 'flex-start',
    ...(Platform.OS === 'web' ? { wordBreak: 'break-word' as any, overflowWrap: 'break-word' as any } : {}),
  },
  agentEventContainer: {
    marginHorizontal: 16,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  toolContainer: {
    marginHorizontal: 16,
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
  userImagesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
    marginBottom: 4,
  },
  userImage: {
    width: '100%',
    maxWidth: 300,
    maxHeight: 300,
    borderRadius: 8,
  },
  userDocumentsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  documentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: theme.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    borderRadius: 10,
  },
  documentName: {
    fontSize: 13,
    color: theme.colors.text,
    maxWidth: 200,
    fontWeight: '700',
  },
  documentSize: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    marginTop: 1,
  },
  voiceBadge: {
    alignSelf: 'flex-end',
    marginTop: -8,
    marginBottom: 8,
    marginRight: 4,
  },
  voiceBadgeText: {
    fontSize: 11,
    color: theme.colors.agentEventText,
    opacity: 0.7,
  },
  messageActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -4,
    marginBottom: 4,
  },
  messageActions: {
    flexDirection: 'row',
    gap: 4,
  },
  messageActionButton: {
    padding: 4,
    borderRadius: 6,
  },
  messageActionIcon: {
    color: theme.colors.textSecondary,
  },
  timestampText: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    opacity: 0.5,
  },
  userMessageMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: -8,
    marginBottom: 4,
    paddingRight: 4,
  },
}));

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
