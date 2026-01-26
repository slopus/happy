import type { StoreGet, StoreSet } from './_shared';

export type RealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type RealtimeMode = 'idle' | 'speaking';
export type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type SyncError = {
  message: string;
  retryable: boolean;
  kind: 'auth' | 'config' | 'network' | 'server' | 'unknown';
  at: number;
  failuresCount?: number;
  nextRetryAt?: number;
} | null;

export type NativeUpdateStatus = { available: boolean; updateUrl?: string } | null;

export type RealtimeDomain = {
  realtimeStatus: RealtimeStatus;
  realtimeMode: RealtimeMode;
  socketStatus: SocketStatus;
  socketLastConnectedAt: number | null;
  socketLastDisconnectedAt: number | null;
  socketLastError: string | null;
  socketLastErrorAt: number | null;
  syncError: SyncError;
  lastSyncAt: number | null;
  nativeUpdateStatus: NativeUpdateStatus;
  applyNativeUpdateStatus: (status: NativeUpdateStatus) => void;
  setRealtimeStatus: (status: RealtimeStatus) => void;
  setRealtimeMode: (mode: RealtimeMode, immediate?: boolean) => void;
  clearRealtimeModeDebounce: () => void;
  setSocketStatus: (status: SocketStatus) => void;
  setSocketError: (message: string | null) => void;
  setSyncError: (error: SyncError) => void;
  clearSyncError: () => void;
  setLastSyncAt: (ts: number) => void;
};

export function createRealtimeDomain<S extends RealtimeDomain>({
  set,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): RealtimeDomain {
  // Debounce timer for realtimeMode changes
  let realtimeModeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const REALTIME_MODE_DEBOUNCE_MS = 150;

  return {
    realtimeStatus: 'disconnected',
    realtimeMode: 'idle',
    socketStatus: 'disconnected',
    socketLastConnectedAt: null,
    socketLastDisconnectedAt: null,
    socketLastError: null,
    socketLastErrorAt: null,
    syncError: null,
    lastSyncAt: null,
    nativeUpdateStatus: null,
    applyNativeUpdateStatus: (status) =>
      set((state) => ({
        ...state,
        nativeUpdateStatus: status,
      })),
    setRealtimeStatus: (status) =>
      set((state) => ({
        ...state,
        realtimeStatus: status,
      })),
    setRealtimeMode: (mode, immediate) => {
      if (immediate) {
        // Clear any pending debounce and set immediately
        if (realtimeModeDebounceTimer) {
          clearTimeout(realtimeModeDebounceTimer);
          realtimeModeDebounceTimer = null;
        }
        set((state) => ({ ...state, realtimeMode: mode }));
      } else {
        // Debounce mode changes to avoid flickering
        if (realtimeModeDebounceTimer) {
          clearTimeout(realtimeModeDebounceTimer);
        }
        realtimeModeDebounceTimer = setTimeout(() => {
          realtimeModeDebounceTimer = null;
          set((state) => ({ ...state, realtimeMode: mode }));
        }, REALTIME_MODE_DEBOUNCE_MS);
      }
    },
    clearRealtimeModeDebounce: () => {
      if (realtimeModeDebounceTimer) {
        clearTimeout(realtimeModeDebounceTimer);
        realtimeModeDebounceTimer = null;
      }
    },
    setSocketStatus: (status) =>
      set((state) => {
        const now = Date.now();
        const updates: Partial<RealtimeDomain> = { socketStatus: status };

        // Update timestamp based on status
        if (status === 'connected') {
          updates.socketLastConnectedAt = now;
          updates.socketLastError = null;
          updates.socketLastErrorAt = null;
        } else if (status === 'disconnected' || status === 'error') {
          updates.socketLastDisconnectedAt = now;
        }

        return {
          ...state,
          ...updates,
        };
      }),
    setSocketError: (message) =>
      set((state) => {
        if (!message) {
          return {
            ...state,
            socketLastError: null,
            socketLastErrorAt: null,
          };
        }
        return {
          ...state,
          socketLastError: message,
          socketLastErrorAt: Date.now(),
        };
      }),
    setSyncError: (error) => set((state) => ({ ...state, syncError: error })),
    clearSyncError: () => set((state) => ({ ...state, syncError: null })),
    setLastSyncAt: (ts) => set((state) => ({ ...state, lastSyncAt: ts })),
  };
}

