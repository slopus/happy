import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React from 'react';
import { View, Pressable, Platform, ActivityIndicator } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Avatar } from './Avatar';
import { CompactGitStatus } from './CompactGitStatus';
import { ProjectGitStatus } from './ProjectGitStatus';
import { StatusDot } from './StatusDot';

import { ContextMenu, ContextMenuAction, useContextMenu } from '@/components/ContextMenu';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineSpawnNewSession } from '@/sync/ops';
import { useAllMachines, useSetting } from '@/sync/storage';
import { storage } from '@/sync/storage';
import { Session, Machine } from '@/sync/storageTypes';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/machineUtils';
import { useIsTablet } from '@/utils/responsive';
import { getSessionName, useSessionStatus, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';




const stylesheet = StyleSheet.create((theme, runtime) => ({
  container: {
    backgroundColor: theme.colors.groupped.background,
    paddingTop: 8,
  },
  projectCard: {
    backgroundColor: theme.colors.surface,
    marginBottom: 8,
    marginHorizontal: Platform.select({ ios: 16, default: 12 }),
    borderRadius: Platform.select({ ios: 10, default: 16 }),
    overflow: 'hidden',
    shadowColor: theme.colors.shadow.color,
    shadowOffset: { width: 0, height: 0.33 },
    shadowOpacity: theme.colors.shadow.opacity,
    shadowRadius: 0,
    elevation: 1,
  },
  sectionHeader: {
    paddingTop: 12,
    paddingBottom: Platform.select({ ios: 6, default: 8 }),
    paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  sectionHeaderPath: {
    ...Typography.default('regular'),
    color: theme.colors.groupped.sectionTitle,
    fontSize: Platform.select({ ios: 13, default: 14 }),
    lineHeight: Platform.select({ ios: 18, default: 20 }),
    letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
    fontWeight: Platform.select({ ios: 'normal', default: '500' }),
  },
  sectionHeaderMachine: {
    ...Typography.default('regular'),
    color: theme.colors.groupped.sectionTitle,
    fontSize: Platform.select({ ios: 13, default: 14 }),
    lineHeight: Platform.select({ ios: 18, default: 20 }),
    letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
    fontWeight: Platform.select({ ios: 'normal', default: '500' }),
    maxWidth: 150,
    textAlign: 'right',
  },
  sessionRow: {
    height: 88,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    backgroundColor: theme.colors.surface,
  },
  sessionRowWithBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  sessionRowSelected: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  sessionContent: {
    flex: 1,
    marginLeft: 16,
    justifyContent: 'center',
  },
  sessionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  sessionTitle: {
    fontSize: 15,
    fontWeight: '500',
    ...Typography.default('semiBold'),
  },
  sessionTitleConnected: {
    color: theme.colors.text,
  },
  sessionTitleDisconnected: {
    color: theme.colors.textSecondary,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  newSessionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.divider,
    backgroundColor: theme.colors.surface,
  },
  newSessionButtonDisabled: {
    opacity: 0.5,
  },
  newSessionButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  newSessionButtonIcon: {
    marginRight: 6,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newSessionButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: theme.colors.text,
    ...Typography.default('semiBold'),
  },
  newSessionButtonTextDisabled: {
    color: theme.colors.textSecondary,
  },
  taskStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHighest,
    paddingHorizontal: 4,
    height: 16,
    borderRadius: 4,
  },
  taskStatusText: {
    fontSize: 10,
    fontWeight: '500',
    color: theme.colors.textSecondary,
    ...Typography.default(),
  },
}));

interface ActiveSessionsGroupProps {
    sessions: Session[];
    selectedSessionId?: string;
}


export function ActiveSessionsGroup({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
  const styles = stylesheet;
  const machines = useAllMachines();
  const machinesMap = React.useMemo(() => {
    const map: Record<string, Machine> = {};
    machines.forEach(machine => {
      map[machine.id] = machine;
    });
    return map;
  }, [machines]);

  // Group sessions by project, then associate with machine
  const projectGroups = React.useMemo(() => {
    const groups = new Map<string, {
            path: string;
            displayPath: string;
            machines: Map<string, {
                machine: Machine | null;
                machineName: string;
                sessions: Session[];
            }>;
        }>();

    sessions.forEach(session => {
      const projectPath = session.metadata?.path || '';
      const machineId = session.metadata?.machineId || 'unknown';

      // Get machine info
      const machine = machineId !== 'unknown' ? machinesMap[machineId] : null;
      const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== 'unknown' ? machineId : '<unknown>');

      // Get or create project group
      let projectGroup = groups.get(projectPath);
      if (!projectGroup) {
        const displayPath = formatPathRelativeToHome(projectPath, session.metadata?.homeDir);
        projectGroup = {
          path: projectPath,
          displayPath,
          machines: new Map(),
        };
        groups.set(projectPath, projectGroup);
      }

      // Get or create machine group within project
      let machineGroup = projectGroup.machines.get(machineId);
      if (!machineGroup) {
        machineGroup = {
          machine,
          machineName,
          sessions: [],
        };
        projectGroup.machines.set(machineId, machineGroup);
      }

      // Add session to machine group
      machineGroup.sessions.push(session);
    });

    // Sort sessions within each machine group by creation time (newest first)
    groups.forEach(projectGroup => {
      projectGroup.machines.forEach(machineGroup => {
        machineGroup.sessions.sort((a, b) => b.createdAt - a.createdAt);
      });
    });

    return groups;
  }, [sessions, machinesMap]);

  // Sort project groups by display path
  const sortedProjectGroups = React.useMemo(() => {
    return Array.from(projectGroups.entries()).sort(([, groupA], [, groupB]) => {
      return groupA.displayPath.localeCompare(groupB.displayPath);
    });
  }, [projectGroups]);

  return (
    <View style={styles.container}>
      {sortedProjectGroups.map(([projectPath, projectGroup]) => {
        // Get the first machine name from this project's machines
        const firstMachine = Array.from(projectGroup.machines.values())[0];
        const machineName = projectGroup.machines.size === 1
          ? firstMachine?.machineName
          : `${projectGroup.machines.size} machines`;

        return (
          <View key={projectPath}>
            {/* Section header on grouped background */}
            <View style={styles.sectionHeader}>
              <View style={styles.sectionHeaderLeft}>
                <Text style={styles.sectionHeaderPath}>
                  {projectGroup.displayPath}
                </Text>
              </View>
              {/* Show git status instead of machine name */}
              {(() => {
                // Get the first session from any machine in this project
                const firstSession = Array.from(projectGroup.machines.values())[0]?.sessions[0];
                return firstSession ? (
                  <ProjectGitStatus sessionId={firstSession.id} />
                ) : (
                  <Text style={styles.sectionHeaderMachine} numberOfLines={1}>
                    {machineName}
                  </Text>
                );
              })()}
            </View>

            {/* Card with just the sessions */}
            <View style={styles.projectCard}>
              {/* Sessions grouped by machine within the card */}
              {Array.from(projectGroup.machines.entries())
                .sort(([, machineA], [, machineB]) => machineA.machineName.localeCompare(machineB.machineName))
                .map(([machineId, machineGroup]) => (
                  <View key={`${projectPath}-${machineId}`}>
                    {machineGroup.sessions.map((session, index) => (
                      <CompactSessionRow
                        key={session.id}
                        session={session}
                        selected={selectedSessionId === session.id}
                        showBorder={index < machineGroup.sessions.length - 1 ||
                                                    Array.from(projectGroup.machines.keys()).indexOf(machineId) < projectGroup.machines.size - 1}
                      />
                    ))}
                  </View>
                ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// Compact session row component with status line
const CompactSessionRow = React.memo(({ session, selected, showBorder }: { session: Session; selected?: boolean; showBorder?: boolean }) => {
  const styles = stylesheet;
  const sessionStatus = useSessionStatus(session);
  const sessionName = getSessionName(session);
  const navigateToSession = useNavigateToSession();
  const isTablet = useIsTablet();
  const contextMenu = useContextMenu();

  const avatarId = React.useMemo(() => {
    return getSessionAvatarId(session);
  }, [session]);

  // Session management functions
  const removeSession = React.useCallback((sessionId: string) => {
    storage.getState().removeSession(sessionId);
  }, []);

  const updateSession = React.useCallback((sessionId: string, sessionData: Session) => {
    storage.getState().updateSession(sessionId, sessionData);
  }, []);

  // Session management actions
  const handleDeleteSession = React.useCallback(async () => {
    const confirmed = await Modal.confirm(
      t('sessions.deleteSessionTitle'),
      t('sessions.deleteSessionMessage', { sessionName: getSessionName(session) }),
    );
    if (confirmed) {
      removeSession(session.id);
    }
  }, [session, removeSession]);

  const handleDuplicateSession = React.useCallback(() => {
    // Generate new session ID
    const newSessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    // Create duplicate session with new ID but same metadata
    const duplicatedSession: Session = {
      ...session,
      id: newSessionId,
      createdAt: Date.now(),
      draft: null, // Clear draft for new session
    };

    // TODO: Also need to duplicate messages - for now just create empty session
    updateSession(newSessionId, duplicatedSession);
    navigateToSession(newSessionId);
  }, [session, updateSession, navigateToSession]);

  const handleCopySessionId = React.useCallback(async () => {
    try {
      await Clipboard.setStringAsync(session.id);
      // Could show toast notification here
    } catch (error) {
      console.error('Failed to copy session ID:', error);
    }
  }, [session.id]);

  const handleRenameSession = React.useCallback(async () => {
    const newName = await Modal.prompt(
      t('sessions.renameSessionTitle'),
      t('sessions.renameSessionMessage'),
      { defaultValue: getSessionName(session) },
    );

    if (newName && newName.trim() && newName.trim() !== getSessionName(session)) {
      const updatedSession = {
        ...session,
        metadata: {
          path: '',
          host: '',
          ...session.metadata,
          displayName: newName.trim(),
        },
      };
      updateSession(session.id, updatedSession);
    }
  }, [session, updateSession]);

  const handleExportHistory = React.useCallback(async () => {
    // TODO: Implement session history export
    Modal.alert(t('common.comingSoon'), t('sessions.exportHistoryComingSoon'));
  }, []);

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
          styles.sessionRow,
          showBorder && styles.sessionRowWithBorder,
          selected && styles.sessionRowSelected,
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
        // Accessibility props
        accessible={true}
        accessibilityRole="button"
        accessibilityLabel={`${sessionName}, ${sessionStatus.statusText}`}
        accessibilityHint="Double tap to open session, long press for more options"
      >
        <View style={styles.avatarContainer}>
          <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} />
        </View>
        <View style={styles.sessionContent}>
          {/* Title line */}
          <View style={styles.sessionTitleRow}>
            <Text
              style={[
                styles.sessionTitle,
                sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
              ]}
              numberOfLines={2}
            >
              {sessionName}
            </Text>
          </View>

          {/* Status line with dot */}
          <View style={styles.statusRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
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

            {/* Status indicators on the right side */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, transform: [{ translateY: 1 }] }}>
              {/* Draft status indicator */}
              {session.draft && (
                <View style={styles.taskStatusContainer}>
                  <Ionicons
                    name="create-outline"
                    size={10}
                    color={styles.taskStatusText.color}
                  />
                </View>
              )}

              {/* No longer showing git status per item - it's in the header */}

              {/* Task status indicator */}
              {session.todos && session.todos.length > 0 && (() => {
                const totalTasks = session.todos.length;
                const completedTasks = session.todos.filter(t => t.status === 'completed').length;

                // Don't show if all tasks are completed
                if (completedTasks === totalTasks) {
                  return null;
                }

                return (
                  <View style={styles.taskStatusContainer}>
                    <Ionicons
                      name="bulb-outline"
                      size={10}
                      color={styles.taskStatusText.color}
                      style={{ marginRight: 2 }}
                    />
                    <Text style={styles.taskStatusText}>
                      {completedTasks}/{totalTasks}
                    </Text>
                  </View>
                );
              })()}
            </View>
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
