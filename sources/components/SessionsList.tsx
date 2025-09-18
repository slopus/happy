import React from 'react';
import { View, Pressable, FlatList, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, useSessionListViewData } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionSubtitle, getSessionAvatarId, deleteSession, duplicateSession, renameSession, copySessionId, exportSessionHistory } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { ActiveSessionsGroup } from './ActiveSessionsGroup';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSetting } from '@/sync/storage';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { StatusDot } from './StatusDot';
import { StyleSheet } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { t } from '@/text';
import { ContextMenu, ContextMenuAction, useContextMenu } from '@/components/ContextMenu';
import { Modal } from '@/modal';
import { storage } from '@/sync/storage';

const stylesheet = StyleSheet.create((theme, runtime) => ({
  container: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'stretch',
    backgroundColor: theme.colors.groupped.background,
  },
  contentContainer: {
    flex: 1,
    maxWidth: layout.maxWidth,
  },
  headerSection: {
    backgroundColor: theme.colors.groupped.background,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 8,
  },
  headerText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.groupped.sectionTitle,
    letterSpacing: 0.1,
    ...Typography.default('semiBold'),
  },
  projectGroup: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: theme.colors.surface,
  },
  projectGroupTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.text,
    ...Typography.default('semiBold'),
  },
  projectGroupSubtitle: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    marginTop: 2,
    ...Typography.default(),
  },
  sessionItem: {
    height: 88,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    backgroundColor: theme.colors.surface,
    marginHorizontal: 16,
    marginBottom: 1,
  },
  sessionItemFirst: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  sessionItemLast: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    marginBottom: 12,
  },
  sessionItemSingle: {
    borderRadius: 12,
    marginBottom: 12,
  },
  sessionItemSelected: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  sessionItemKeyboardFocused: {
    borderWidth: Platform.select({ web: 2, default: 1 }),
    borderColor: theme.colors.textLink,
    backgroundColor: Platform.select({
      web: theme.colors.input.background,
      default: theme.colors.surfaceHigh,
    }),
  },
  sessionContent: {
    flex: 1,
    marginLeft: 16,
    justifyContent: 'center',
  },
  sessionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  sessionTitle: {
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
    ...Typography.default('semiBold'),
  },
  sessionTitleConnected: {
    color: theme.colors.text,
  },
  sessionTitleDisconnected: {
    color: theme.colors.textSecondary,
  },
  sessionSubtitle: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginBottom: 4,
    ...Typography.default(),
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDotContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 16,
    marginTop: 2,
    marginRight: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 16,
    ...Typography.default(),
  },
  avatarContainer: {
    position: 'relative',
    width: 48,
    height: 48,
  },
  draftIconContainer: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  draftIconOverlay: {
    color: theme.colors.textSecondary,
  },
}));

export function SessionsList() {
  const styles = stylesheet;
  const safeArea = useSafeAreaInsets();
  const data = useSessionListViewData();
  const pathname = usePathname();
  const isTablet = useIsTablet();
  const navigateToSession = useNavigateToSession();
  const compactSessionView = useSetting('compactSessionView');
  const selectable = isTablet;
  const removeSession = React.useCallback((sessionId: string) => {
    storage.getState().removeSession(sessionId);
  }, []);
  const [selectedSessionIndex, setSelectedSessionIndex] = React.useState<number>(-1);
  const [focusedSessionId, setFocusedSessionId] = React.useState<string | null>(null);

  // Keyboard shortcuts for session management
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle shortcuts when on sessions list screen
      if (!pathname.startsWith('/') || pathname !== '/') return;

      const sessions = data?.filter(item => item.type === 'session').map(item => (item as any).session) || [];
      if (sessions.length === 0) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedSessionIndex(prev => {
            const newIndex = prev < sessions.length - 1 ? prev + 1 : prev;
            setFocusedSessionId(sessions[newIndex]?.id || null);
            return newIndex;
          });
          break;

        case 'ArrowUp':
          event.preventDefault();
          setSelectedSessionIndex(prev => {
            const newIndex = prev > 0 ? prev - 1 : prev;
            setFocusedSessionId(sessions[newIndex]?.id || null);
            return newIndex;
          });
          break;

        case 'Enter':
          event.preventDefault();
          if (selectedSessionIndex >= 0 && selectedSessionIndex < sessions.length) {
            const session = sessions[selectedSessionIndex];
            navigateToSession(session.id);
          }
          break;

        case 'Delete':
        case 'Backspace':
          if (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) {
            event.preventDefault();
            if (selectedSessionIndex >= 0 && selectedSessionIndex < sessions.length) {
              const session = sessions[selectedSessionIndex];
              deleteSession(session).then(wasDeleted => {
                if (wasDeleted) {
                  // Adjust selection after deletion
                  setSelectedSessionIndex(prev => Math.max(0, Math.min(prev, sessions.length - 2)));
                }
              });
            }
          }
          break;

        case 'F2':
          event.preventDefault();
          if (selectedSessionIndex >= 0 && selectedSessionIndex < sessions.length) {
            const session = sessions[selectedSessionIndex];
            renameSession(session);
          }
          break;

        case 'Escape':
          event.preventDefault();
          setSelectedSessionIndex(-1);
          setFocusedSessionId(null);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [data, pathname, selectedSessionIndex, navigateToSession, removeSession]);

  const dataWithSelected = React.useMemo(() => {
    if (!selectable) return data;
    return data?.map(item => ({
      ...item,
      selected: pathname.startsWith(`/session/${item.type === 'session' ? item.session.id : ''}`),
    }));
  }, [data, pathname, selectable]);

  // Request review
  React.useEffect(() => {
    if (data && data.length > 0) {
      requestReview();
    }
  }, [data && data.length > 0]);

  const keyExtractor = React.useCallback((item: SessionListViewItem & { selected?: boolean }, index: number) => {
    switch (item.type) {
      case 'header': return `header-${item.title}-${index}`;
      case 'active-sessions': return 'active-sessions';
      case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
      case 'session': return `session-${item.session.id}`;
    }
  }, []);

  const renderItem = React.useCallback(({ item, index }: { item: SessionListViewItem & { selected?: boolean }, index: number }) => {
    switch (item.type) {
      case 'header':
        return (
          <View style={styles.headerSection}>
            <Text style={styles.headerText}>
              {item.title}
            </Text>
          </View>
        );

      case 'active-sessions':
        // Extract just the session ID from pathname (e.g., /session/abc123/file -> abc123)
        let selectedId: string | undefined;
        if (isTablet && pathname.startsWith('/session/')) {
          const parts = pathname.split('/');
          selectedId = parts[2]; // parts[0] is empty, parts[1] is 'session', parts[2] is the ID
        }

        const ActiveComponent = compactSessionView ? ActiveSessionsGroupCompact : ActiveSessionsGroup;
        return (
          <ActiveComponent
            sessions={item.sessions}
            selectedSessionId={selectedId}
          />
        );

      case 'project-group':
        return (
          <View style={styles.projectGroup}>
            <Text style={styles.projectGroupTitle}>
              {item.displayPath}
            </Text>
            <Text style={styles.projectGroupSubtitle}>
              {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
            </Text>
          </View>
        );

      case 'session':
        // Determine card styling based on position within date group
        const prevItem = index > 0 && dataWithSelected ? dataWithSelected[index - 1] : null;
        const nextItem = index < (dataWithSelected?.length || 0) - 1 && dataWithSelected ? dataWithSelected[index + 1] : null;

        const isFirst = prevItem?.type === 'header';
        const isLast = nextItem?.type === 'header' || nextItem == null || nextItem?.type === 'active-sessions';
        const isSingle = isFirst && isLast;

        return (
          <SessionItem
            session={item.session}
            selected={item.selected}
            keyboardFocused={focusedSessionId === item.session.id}
            isFirst={isFirst}
            isLast={isLast}
            isSingle={isSingle}
          />
        );
    }
  }, [pathname, dataWithSelected, compactSessionView, focusedSessionId]);

  const HeaderComponent = React.useCallback(() => {
    return (
      <View style={{ marginHorizontal: -4 }}>
        <UpdateBanner />
      </View>
    );
  }, []);

  // Early return if no data yet
  if (!data) {
    return (
      <View style={styles.container} />
    );
  }

  // Footer removed - all sessions now shown inline

  return (
    <View style={styles.container}>
      <View style={styles.contentContainer}>
        <FlatList
          data={dataWithSelected}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={{ paddingBottom: safeArea.bottom + 128, maxWidth: layout.maxWidth }}
          ListHeaderComponent={HeaderComponent}
        />
      </View>
    </View>
  );
}

// Sub-component that handles session message logic
const SessionItem = React.memo(({ session, selected, keyboardFocused, isFirst, isLast, isSingle }: {
    session: Session;
    selected?: boolean;
    keyboardFocused?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
}) => {
  const styles = stylesheet;
  const sessionStatus = useSessionStatus(session);
  const sessionName = getSessionName(session);
  const sessionSubtitle = getSessionSubtitle(session);
  const navigateToSession = useNavigateToSession();
  const isTablet = useIsTablet();
  const contextMenu = useContextMenu();

  const avatarId = React.useMemo(() => {
    return getSessionAvatarId(session);
  }, [session]);

  // Session management actions using utility functions
  const handleDeleteSession = React.useCallback(async () => {
    await deleteSession(session);
  }, [session]);

  const handleDuplicateSession = React.useCallback(async () => {
    const newSessionId = await duplicateSession(session);
    if (newSessionId) {
      navigateToSession(newSessionId);
    }
  }, [session, navigateToSession]);

  const handleCopySessionId = React.useCallback(async () => {
    await copySessionId(session);
  }, [session]);

  const handleRenameSession = React.useCallback(async () => {
    await renameSession(session);
  }, [session]);

  const handleExportHistory = React.useCallback(async () => {
    await exportSessionHistory(session);
  }, [session]);

  // Context menu actions
  const contextMenuActions = React.useMemo((): ContextMenuAction[] => [
    {
      id: 'rename',
      title: t('sessions.rename'),
      icon: 'create-outline',
      onPress: handleRenameSession,
      shortcut: Platform.OS === 'web' ? 'F2' : undefined,
    },
    {
      id: 'duplicate',
      title: t('sessions.duplicate'),
      icon: 'copy-outline',
      onPress: handleDuplicateSession,
      shortcut: Platform.OS === 'web' ? '⌘D' : undefined,
    },
    {
      id: 'copy-id',
      title: t('sessions.copyId'),
      icon: 'clipboard-outline',
      onPress: handleCopySessionId,
      shortcut: Platform.OS === 'web' ? '⌘C' : undefined,
    },
    {
      id: 'export',
      title: t('sessions.exportHistory'),
      icon: 'download-outline',
      onPress: handleExportHistory,
    },
    {
      id: 'delete',
      title: t('sessions.delete'),
      icon: 'trash-outline',
      destructive: true,
      onPress: handleDeleteSession,
      shortcut: Platform.OS === 'web' ? 'Delete' : undefined,
    },
  ], [handleRenameSession, handleDuplicateSession, handleCopySessionId, handleExportHistory, handleDeleteSession]);

  // Handle long press for context menu (mobile)
  const handleLongPress = React.useCallback(() => {
    const screenWidth = Platform.select({
      web: window.innerWidth,
      default: require('react-native').Dimensions.get('window').width,
    });
    const position = { x: screenWidth / 2 - 140, y: 200 };
    contextMenu.show(position);
  }, [contextMenu]);

  // Handle right click for context menu (web)
  const handleRightClick = React.useCallback((event: any) => {
    if (Platform.OS === 'web') {
      event.preventDefault();
      const position = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
      contextMenu.show(position);
    }
  }, [contextMenu]);

  return (
    <>
      <Pressable
        style={[
          styles.sessionItem,
          selected && styles.sessionItemSelected,
          keyboardFocused && styles.sessionItemKeyboardFocused,
          isSingle ? styles.sessionItemSingle :
            isFirst ? styles.sessionItemFirst :
              isLast ? styles.sessionItemLast : {},
        ]}
        onPressIn={() => {
          if (isTablet) {
            navigateToSession(session.id);
          }
        }}
        onPress={() => {
          if (!isTablet) {
            navigateToSession(session.id);
          }
        }}
        onLongPress={handleLongPress}
        {...(Platform.OS === 'web' && {
          onContextMenu: handleRightClick,
        })}
      >
        <View style={styles.avatarContainer}>
          <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} />
          {session.draft && (
            <View style={styles.draftIconContainer}>
              <Ionicons
                name="create-outline"
                size={12}
                style={styles.draftIconOverlay}
              />
            </View>
          )}
        </View>
        <View style={styles.sessionContent}>
          {/* Title line */}
          <View style={styles.sessionTitleRow}>
            <Text style={[
              styles.sessionTitle,
              sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
            ]} numberOfLines={1}> {/* {variant !== 'no-path' ? 1 : 2} - issue is we don't have anything to take this space yet and it looks strange - if summaries were more reliably generated, we can add this. While no summary - add something like "New session" or "Empty session", and extend summary to 2 lines once we have it */}
              {sessionName}
            </Text>
          </View>

          {/* Subtitle line */}
          <Text style={styles.sessionSubtitle} numberOfLines={1}>
            {sessionSubtitle}
          </Text>

          {/* Status line with dot */}
          <View style={styles.statusRow}>
            <View style={styles.statusDotContainer}>
              <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
            </View>
            <Text style={[
              styles.statusText,
              { color: sessionStatus.statusColor },
            ]}>
              {sessionStatus.statusText}
            </Text>
          </View>
        </View>
      </Pressable>

      {/* Context Menu */}
      <ContextMenu
        visible={contextMenu.visible}
        onClose={contextMenu.hide}
        actions={contextMenuActions}
        anchorPosition={contextMenu.anchorPosition}
        title={getSessionName(session)}
      />
    </>
  );
});