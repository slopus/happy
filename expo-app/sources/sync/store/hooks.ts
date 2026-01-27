import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type {
  DiscardedPendingMessage,
  GitStatus,
  Machine,
  PendingMessage,
  Session,
} from '../storageTypes';
import type { DecryptedArtifact } from '../artifactTypes';
import type { LocalSettings } from '../localSettings';
import type { Message } from '../typesMessage';
import type { Settings } from '../settings';
import type { SessionListViewItem } from '../sessionListViewData';
import { computeHasUnreadActivity, computePendingActivityAt } from '../unread';
import { sync } from '../sync';

import { getStorage } from '../storage';
import type { KnownEntitlements } from '../storage';

export function useSessions() {
  return getStorage()(useShallow((state) => (state.isDataReady ? state.sessionsData : null)));
}

export function useSession(id: string): Session | null {
  return getStorage()(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: unknown[] = [];

export function useSessionMessages(
  sessionId: string
): { messages: Message[]; isLoaded: boolean } {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return {
        messages: session?.messages ?? emptyArray,
        isLoaded: session?.isLoaded ?? false,
      };
    })
  );
}

export function useHasUnreadMessages(sessionId: string): boolean {
  return getStorage()((state) => {
    const session = state.sessions[sessionId];
    if (!session) return false;
    const pendingActivityAt = computePendingActivityAt(session.metadata);
    const readState = session.metadata?.readStateV1;
    return computeHasUnreadActivity({
      sessionSeq: session.seq ?? 0,
      pendingActivityAt,
      lastViewedSessionSeq: readState?.sessionSeq,
      lastViewedPendingActivityAt: readState?.pendingActivityAt,
    });
  });
}

export function useSessionPendingMessages(
  sessionId: string
): { messages: PendingMessage[]; discarded: DiscardedPendingMessage[]; isLoaded: boolean } {
  return getStorage()(
    useShallow((state) => {
      const pending = state.sessionPending[sessionId];
      return {
        messages: pending?.messages ?? emptyArray,
        discarded: pending?.discarded ?? emptyArray,
        isLoaded: pending?.isLoaded ?? false,
      };
    })
  );
}

export function useMessage(sessionId: string, messageId: string): Message | null {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return session?.messagesMap[messageId] ?? null;
    })
  );
}

export function useSessionUsage(sessionId: string) {
  return getStorage()(
    useShallow((state) => {
      const session = state.sessionMessages[sessionId];
      return session?.reducerState?.latestUsage ?? null;
    })
  );
}

export function useSettings(): Settings {
  return getStorage()(useShallow((state) => state.settings));
}

export function useSettingMutable<K extends keyof Settings>(
  name: K
): [Settings[K], (value: Settings[K]) => void] {
  const setValue = React.useCallback(
    (value: Settings[K]) => {
      sync.applySettings({ [name]: value });
    },
    [name]
  );
  const value = useSetting(name);
  return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
  return getStorage()(useShallow((state) => state.settings[name]));
}

export function useLocalSettings(): LocalSettings {
  return getStorage()(useShallow((state) => state.localSettings));
}

export function useAllMachines(): Machine[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      return Object.values(state.machines)
        .sort((a, b) => b.createdAt - a.createdAt)
        .filter((v) => v.active);
    })
  );
}

export function useMachine(machineId: string): Machine | null {
  return getStorage()(useShallow((state) => state.machines[machineId] ?? null));
}

export function useSessionListViewData(): SessionListViewItem[] | null {
  return getStorage()((state) => (state.isDataReady ? state.sessionListViewData : null));
}

export function useAllSessions(): Session[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      return Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(
  name: K
): [LocalSettings[K], (value: LocalSettings[K]) => void] {
  const setValue = React.useCallback(
    (value: LocalSettings[K]) => {
      getStorage().getState().applyLocalSettings({ [name]: value });
    },
    [name]
  );
  const value = useLocalSetting(name);
  return [value, setValue];
}

// Project management hooks
export function useProjects() {
  return getStorage()(useShallow((state) => state.getProjects()));
}

export function useProject(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProject(projectId) : null)));
}

export function useProjectForSession(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getProjectForSession(sessionId) : null))
  );
}

export function useProjectSessions(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProjectSessions(projectId) : [])));
}

export function useProjectGitStatus(projectId: string | null) {
  return getStorage()(useShallow((state) => (projectId ? state.getProjectGitStatus(projectId) : null)));
}

export function useSessionProjectGitStatus(sessionId: string | null) {
  return getStorage()(
    useShallow((state) => (sessionId ? state.getSessionProjectGitStatus(sessionId) : null))
  );
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
  return getStorage()(useShallow((state) => state.localSettings[name]));
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Filter out draft artifacts from the main list
      return Object.values(state.artifacts)
        .filter((artifact) => !artifact.draft)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useAllArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Return all artifacts including drafts
      return Object.values(state.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useDraftArtifacts(): DecryptedArtifact[] {
  return getStorage()(
    useShallow((state) => {
      if (!state.isDataReady) return [];
      // Return only draft artifacts
      return Object.values(state.artifacts)
        .filter((artifact) => artifact.draft === true)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    })
  );
}

export function useArtifact(artifactId: string): DecryptedArtifact | null {
  return getStorage()(useShallow((state) => state.artifacts[artifactId] ?? null));
}

export function useArtifactsCount(): number {
  return getStorage()(
    useShallow((state) => {
      // Count only non-draft artifacts
      return Object.values(state.artifacts).filter((a) => !a.draft).length;
    })
  );
}

export function useEntitlement(id: KnownEntitlements): boolean {
  return getStorage()(useShallow((state) => state.purchases.entitlements[id] ?? false));
}

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
  return getStorage()(useShallow((state) => state.realtimeStatus));
}

export function useRealtimeMode(): 'idle' | 'speaking' {
  return getStorage()(useShallow((state) => state.realtimeMode));
}

export function useSocketStatus() {
  return getStorage()(
    useShallow((state) => ({
      status: state.socketStatus,
      lastConnectedAt: state.socketLastConnectedAt,
      lastDisconnectedAt: state.socketLastDisconnectedAt,
      lastError: state.socketLastError,
      lastErrorAt: state.socketLastErrorAt,
    }))
  );
}

export function useSyncError() {
  return getStorage()(useShallow((state) => state.syncError));
}

export function useLastSyncAt() {
  return getStorage()(useShallow((state) => state.lastSyncAt));
}

export function useSessionGitStatus(sessionId: string): GitStatus | null {
  return getStorage()(useShallow((state) => state.sessionGitStatus[sessionId] ?? null));
}

export function useIsDataReady(): boolean {
  return getStorage()(useShallow((state) => state.isDataReady));
}

export function useProfile() {
  return getStorage()(useShallow((state) => state.profile));
}

export function useFriends() {
  return getStorage()(useShallow((state) => state.friends));
}

export function useFriendRequests() {
  return getStorage()(
    useShallow((state) => {
      // Filter friends to get pending requests (where status is 'pending')
      return Object.values(state.friends).filter((friend) => friend.status === 'pending');
    })
  );
}

export function useAcceptedFriends() {
  return getStorage()(
    useShallow((state) => {
      return Object.values(state.friends).filter((friend) => friend.status === 'friend');
    })
  );
}

export function useFeedItems() {
  return getStorage()(useShallow((state) => state.feedItems));
}
export function useFeedLoaded() {
  return getStorage()((state) => state.feedLoaded);
}
export function useFriendsLoaded() {
  return getStorage()((state) => state.friendsLoaded);
}

export function useFriend(userId: string | undefined) {
  return getStorage()(useShallow((state) => (userId ? state.friends[userId] : undefined)));
}

export function useUser(userId: string | undefined) {
  return getStorage()(useShallow((state) => (userId ? state.users[userId] : undefined)));
}

export function useRequestedFriends() {
  return getStorage()(
    useShallow((state) => {
      // Filter friends to get sent requests (where status is 'requested')
      return Object.values(state.friends).filter((friend) => friend.status === 'requested');
    })
  );
}
