import * as React from 'react';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { Modal } from '@/modal';
import { storage } from '@/sync/storage';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

export type SessionState = 'disconnected' | 'thinking' | 'waiting' | 'permission_required';

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}

/**
 * Get the current state of a session based on presence and thinking status.
 * Uses centralized session state from storage.ts
 */
export function useSessionStatus(session: Session): SessionStatus {
  const isOnline = session.presence === 'online';
  const hasPermissions = (session.agentState?.requests && Object.keys(session.agentState.requests).length > 0 ? true : false);

  const vibingMessage = React.useMemo(() => {
    return `${vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase()  }…`;
  }, [isOnline, hasPermissions, session.thinking]);

  if (!isOnline) {
    return {
      state: 'disconnected',
      isConnected: false,
      statusText: t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) }),
      shouldShowStatus: true,
      statusColor: '#999',
      statusDotColor: '#999',
    };
  }

  // Check if permission is required
  if (hasPermissions) {
    return {
      state: 'permission_required',
      isConnected: true,
      statusText: t('status.permissionRequired'),
      shouldShowStatus: true,
      statusColor: '#FF9500',
      statusDotColor: '#FF9500',
      isPulsing: true,
    };
  }

  if (session.thinking === true) {
    return {
      state: 'thinking',
      isConnected: true,
      statusText: vibingMessage,
      shouldShowStatus: true,
      statusColor: '#007AFF',
      statusDotColor: '#007AFF',
      isPulsing: true,
    };
  }

  return {
    state: 'waiting',
    isConnected: true,
    statusText: t('status.online'),
    shouldShowStatus: false,
    statusColor: '#34C759',
    statusDotColor: '#34C759',
  };
}

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or 'unknown' if no path is available.
 */
export function getSessionName(session: Session): string {
  if (session.metadata?.summary) {
    return session.metadata.summary.text;
  } else if (session.metadata) {
    const segments = session.metadata.path.split('/').filter(Boolean);
    const lastSegment = segments.pop()!;
    return lastSegment;
  }
  return t('status.unknown');
}

/**
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
export function getSessionAvatarId(session: Session): string {
  if (session.metadata?.machineId && session.metadata?.path) {
    // Combine machine ID and path for a unique, deterministic avatar
    return `${session.metadata.machineId}:${session.metadata.path}`;
  }
  // Fallback to session ID if metadata is missing
  return session.id;
}

/**
 * Formats a path relative to home directory if possible.
 * If the path starts with the home directory, replaces it with ~
 * Otherwise returns the full path.
 */
export function formatPathRelativeToHome(path: string, homeDir?: string): string {
  if (!homeDir) return path;
    
  // Normalize paths to handle trailing slashes
  const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
  const normalizedPath = path;
    
  // Check if path starts with home directory
  if (normalizedPath.startsWith(normalizedHome)) {
    // Replace home directory with ~
    const relativePath = normalizedPath.slice(normalizedHome.length);
    // Add ~ and ensure there's a / after it if needed
    if (relativePath.startsWith('/')) {
      return `~${  relativePath}`;
    } else if (relativePath === '') {
      return '~';
    } else {
      return `~/${  relativePath}`;
    }
  }
    
  return path;
}

/**
 * Returns the session path for the subtitle.
 */
export function getSessionSubtitle(session: Session): string {
  if (session.metadata) {
    return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
  }
  return t('status.unknown');
}

/**
 * Checks if a session is currently online based on the active flag.
 * A session is considered online if the active flag is true.
 */
export function isSessionOnline(session: Session): boolean {
  return session.active;
}

/**
 * Checks if a session should be shown in the active sessions group.
 * Uses the active flag directly.
 */
export function isSessionActive(session: Session): boolean {
  return session.active;
}

/**
 * Formats OS platform string into a more readable format
 */
export function formatOSPlatform(platform?: string): string {
  if (!platform) return '';

  const osMap: Record<string, string> = {
    'darwin': 'macOS',
    'win32': 'Windows',
    'linux': 'Linux',
    'android': 'Android',
    'ios': 'iOS',
    'aix': 'AIX',
    'freebsd': 'FreeBSD',
    'openbsd': 'OpenBSD',
    'sunos': 'SunOS',
  };

  return osMap[platform.toLowerCase()] || platform;
}

/**
 * Formats the last seen time of a session into a human-readable relative time.
 * @param activeAt - Timestamp when the session was last active
 * @param isActive - Whether the session is currently active
 * @returns Formatted string like "Active now", "5 minutes ago", "2 hours ago", or a date
 */
export function formatLastSeen(activeAt: number, isActive: boolean = false): string {
  if (isActive) {
    return t('status.activeNow');
  }

  const now = Date.now();
  const diffMs = now - activeAt;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return t('time.justNow');
  } else if (diffMinutes < 60) {
    return t('time.minutesAgo', { count: diffMinutes });
  } else if (diffHours < 24) {
    return t('time.hoursAgo', { count: diffHours });
  } else if (diffDays < 7) {
    return t('sessionHistory.daysAgo', { count: diffDays });
  } else {
    // Format as date
    const date = new Date(activeAt);
    const options: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    };
    return date.toLocaleDateString(undefined, options);
  }
}

const vibingMessages = ['Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Booping', 'Brewing', 'Calculating', 'Cerebrating', 'Channelling', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Computing', 'Combobulating', 'Concocting', 'Conjuring', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Deciphering', 'Deliberating', 'Determining', 'Discombobulating', 'Divining', 'Doing', 'Effecting', 'Elucidating', 'Enchanting', 'Envisioning', 'Finagling', 'Flibbertigibbeting', 'Forging', 'Forming', 'Frolicking', 'Generating', 'Germinating', 'Hatching', 'Herding', 'Honking', 'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Manifesting', 'Marinating', 'Meandering', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Noodling', 'Percolating', 'Perusing', 'Philosophising', 'Pontificating', 'Pondering', 'Processing', 'Puttering', 'Puzzling', 'Reticulating', 'Ruminating', 'Scheming', 'Schlepping', 'Shimmying', 'Simmering', 'Smooshing', 'Spelunking', 'Spinning', 'Stewing', 'Sussing', 'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Unravelling', 'Vibing', 'Wandering', 'Whirring', 'Wibbling', 'Wizarding', 'Working', 'Wrangling'];

/**
 * Session Action Utilities
 * These functions handle the core session management actions for context menus
 */

/**
 * Deletes a session with confirmation modal
 */
export async function deleteSession(session: Session): Promise<boolean> {
  try {
    const confirmed = await Modal.confirm(
      t('sessions.deleteSessionTitle'),
      t('sessions.deleteSessionMessage', { sessionName: getSessionName(session) }),
      {
        destructive: true,
        confirmText: t('sessions.delete'),
        cancelText: t('common.cancel'),
      },
    );

    if (confirmed) {
      storage.getState().removeSession(session.id);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting session:', error);
    Modal.alert(t('common.error'), t('errors.operationFailed'));
    return false;
  }
}

/**
 * Duplicates a session, creating a new session with the same metadata
 */
export async function duplicateSession(session: Session): Promise<string | null> {
  try {
    // Generate new session ID
    const newSessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    // Create duplicate session with new ID but same metadata
    const duplicatedSession: Session = {
      ...session,
      id: newSessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      draft: null, // Clear draft for new session
      activeAt: Date.now(),
      active: false, // New session starts inactive
      presence: Date.now(), // Set presence to current timestamp (offline)
      thinking: false,
      thinkingAt: 0,
      seq: 0, // Reset sequence number
      metadataVersion: session.metadataVersion,
      agentStateVersion: 0, // Reset agent state version
      agentState: null, // Reset agent state
    };

    // Copy session metadata with updated summary to indicate it's a duplicate
    if (duplicatedSession.metadata) {
      const originalName = getSessionName(session);
      duplicatedSession.metadata = {
        ...duplicatedSession.metadata,
        summary: {
          text: t('sessions.duplicatePrefix', { originalName }),
          updatedAt: Date.now(),
        },
      };
    }

    // Add the session to storage
    storage.getState().updateSession(newSessionId, duplicatedSession);

    // Note: Message duplication is complex due to the normalized message structure
    // For now, we create an empty session. Message duplication can be added later
    // as a separate feature if needed.

    return newSessionId;
  } catch (error) {
    console.error('Error duplicating session:', error);
    Modal.alert(t('common.error'), t('errors.operationFailed'));
    return null;
  }
}

/**
 * Renames a session with prompt modal
 */
export async function renameSession(session: Session): Promise<boolean> {
  try {
    const currentName = getSessionName(session);
    const newName = await Modal.prompt(
      t('sessions.renameSessionTitle'),
      t('sessions.renameSessionMessage'),
      {
        defaultValue: currentName,
        placeholder: t('sessions.sessionNamePlaceholder'),
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );

    if (newName && newName.trim() && newName.trim() !== currentName) {
      const updatedSession: Session = {
        ...session,
        metadata: {
          path: '',
          host: '',
          ...session.metadata,
          summary: {
            text: newName.trim(),
            updatedAt: Date.now(),
          },
        },
      };

      storage.getState().updateSession(session.id, updatedSession);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error renaming session:', error);
    Modal.alert(t('common.error'), t('errors.operationFailed'));
    return false;
  }
}

/**
 * Copies session ID to clipboard
 */
export async function copySessionId(session: Session): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(session.id);

    // Show success feedback
    if (Platform.OS === 'web') {
      // For web, we can show a temporary notification or use the modal system
      Modal.alert(t('common.success'), t('sessions.sessionIdCopied'));
    }

    return true;
  } catch (error) {
    console.error('Error copying session ID:', error);
    Modal.alert(t('common.error'), t('sessions.failedToCopySessionId'));
    return false;
  }
}

/**
 * Exports session history as JSON file
 */
export async function exportSessionHistory(session: Session): Promise<boolean> {
  try {
    const sessionMessages = storage.getState().sessionMessages[session.id];

    // Prepare export data
    const exportData = {
      session: {
        id: session.id,
        name: getSessionName(session),
        subtitle: getSessionSubtitle(session),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        metadata: session.metadata,
        latestUsage: session.latestUsage,
      },
      messages: sessionMessages?.messages || [],
      exportedAt: Date.now(),
      version: '1.0.0',
    };

    const jsonContent = JSON.stringify(exportData, null, 2);
    const fileName = `session-${getSessionName(session).replace(/[^a-zA-Z0-9]/g, '-')}-${new Date().toISOString().split('T')[0]}.json`;

    if (Platform.OS === 'web') {
      // For web, create download
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } else {
      // For mobile, save to documents directory and share
      const fileUri = FileSystem.documentDirectory + fileName;
      await FileSystem.writeAsStringAsync(fileUri, jsonContent);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/json',
          dialogTitle: t('sessions.exportHistory'),
        });
      } else {
        Modal.alert(t('common.success'), t('sessions.exportSaved', { fileName }));
      }
    }

    return true;
  } catch (error) {
    console.error('Error exporting session history:', error);
    Modal.alert(t('common.error'), t('sessions.exportFailed'));
    return false;
  }
}