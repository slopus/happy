import type { HappySessionClientLike } from './offline-stub';
import { ConnectionState, type PiHappyUiLike } from './types';

export const PI_HAPPY_STATUS_KEY = 'pi-happy';
export const PI_HAPPY_WIDGET_KEY = 'happy-session';

export const STATUS_CONNECTED = '📱 Happy: Connected';
export const STATUS_CONNECTING = '📱 Happy: Connecting...';
export const STATUS_RECONNECTING = '📱 Happy: Reconnecting...';
export const STATUS_OFFLINE = '📱 Happy: Offline (reconnecting)';
export const STATUS_DISCONNECTED = '📱 Happy: Disconnected';
export const STATUS_NOT_LOGGED_IN = "📱 Happy: Not logged in (run 'happy login')";

export const NOTIFICATION_MOBILE_MESSAGE = '📱 Message from Happy';
export const NOTIFICATION_RECONNECTED = '📱 Happy: Reconnected!';
export const NOTIFICATION_SYNC_FAILING = 'Happy sync failing';

/**
 * Map a ConnectionState to its display label.
 */
export function getConnectionStatusLabel(state: ConnectionState): string {
  switch (state) {
    case ConnectionState.Connected:
      return STATUS_CONNECTED;
    case ConnectionState.Connecting:
      return STATUS_RECONNECTING;
    case ConnectionState.Offline:
      return STATUS_OFFLINE;
    case ConnectionState.Disconnected:
    default:
      return STATUS_DISCONNECTED;
  }
}

/**
 * Truncate a session ID for display: first 8 characters + ellipsis.
 */
export function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 12) {
    return sessionId;
  }
  return `${sessionId.slice(0, 8)}…`;
}

/**
 * Format a duration in milliseconds into a human-readable uptime string.
 */
export function formatUptime(durationMs: number): string {
  if (durationMs < 0) {
    return '0s';
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

/**
 * Connection statistics tracked during the session lifecycle.
 */
export interface ConnectionStats {
  messagesSent: number;
  messagesReceived: number;
  connectedSince: number | null;
}

export function createConnectionStats(): ConnectionStats {
  return {
    messagesSent: 0,
    messagesReceived: 0,
    connectedSince: null,
  };
}

/**
 * Build widget lines showing session ID, connection uptime, and message counts.
 */
export function buildWidgetLines(
  sessionId: string,
  stats: ConnectionStats,
  connectionState: ConnectionState,
  now: number = Date.now(),
): string[] {
  const lines: string[] = [];

  const truncatedId = truncateSessionId(sessionId);
  const stateLabel = getConnectionStatusLabel(connectionState);

  let uptimeStr = '—';
  if (stats.connectedSince !== null && connectionState === ConnectionState.Connected) {
    uptimeStr = formatUptime(now - stats.connectedSince);
  }

  lines.push(`${stateLabel}  Session: ${truncatedId}`);
  lines.push(`Uptime: ${uptimeStr}  Sent: ${stats.messagesSent}  Recv: ${stats.messagesReceived}`);

  return lines;
}

// ---------------------------------------------------------------------------
// UI update helpers guarded by ctx.hasUI
// ---------------------------------------------------------------------------

export function setStatus(
  hasUI: boolean,
  ui: PiHappyUiLike,
  status: string | undefined,
): void {
  if (hasUI) {
    ui.setStatus?.(PI_HAPPY_STATUS_KEY, status);
  }
}

export function setWidget(
  hasUI: boolean,
  ui: PiHappyUiLike,
  lines: string[] | undefined,
): void {
  if (hasUI) {
    ui.setWidget?.(PI_HAPPY_WIDGET_KEY, lines);
  }
}

export function notifyInfo(
  hasUI: boolean,
  ui: PiHappyUiLike,
  message: string,
): void {
  if (hasUI) {
    ui.notify?.(message, 'info');
  }
}

export function notifyWarning(
  hasUI: boolean,
  ui: PiHappyUiLike,
  message: string,
): void {
  if (hasUI) {
    ui.notify?.(message, 'warning');
  }
}

// ---------------------------------------------------------------------------
// ConnectionUIManager — orchestrates status, widget, and notification updates.
// ---------------------------------------------------------------------------

/**
 * Manages all Happy-related UI state: status line, widget, and notifications.
 * Listens to client connection state events and keeps the UI in sync.
 */
export class ConnectionUIManager {
  private readonly hasUI: boolean;
  private readonly ui: PiHappyUiLike;
  readonly stats: ConnectionStats;
  private widgetUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private currentConnectionState = ConnectionState.Disconnected;
  private previousConnectionState = ConnectionState.Disconnected;
  private sessionId: string | null = null;

  constructor(hasUI: boolean, ui: PiHappyUiLike) {
    this.hasUI = hasUI;
    this.ui = ui;
    this.stats = createConnectionStats();
  }

  /**
   * Bind to a session client and begin tracking its connection state.
   */
  attach(client: HappySessionClientLike): void {
    this.sessionId = client.sessionId;
    this.currentConnectionState = client.getConnectionState();

    if (this.currentConnectionState === ConnectionState.Connected) {
      this.stats.connectedSince = Date.now();
    }

    client.on('connectionState', (state: ConnectionState) => {
      this.handleConnectionStateChange(state);
    });

    this.refreshStatus();
    this.startWidgetLoop();
  }

  /**
   * Detach from the current session and clear all UI.
   */
  detach(): void {
    this.stopWidgetLoop();
    this.sessionId = null;
    this.currentConnectionState = ConnectionState.Disconnected;
    this.stats.connectedSince = null;
    setStatus(this.hasUI, this.ui, STATUS_DISCONNECTED);
    setWidget(this.hasUI, this.ui, undefined);
  }

  /**
   * Replace the tracked session ID (e.g. after offline → live swap).
   */
  updateSessionId(newId: string): void {
    this.sessionId = newId;
    this.refreshWidget();
  }

  /**
   * Record an outbound message.
   */
  recordSent(): void {
    this.stats.messagesSent += 1;
  }

  /**
   * Record an inbound message.
   */
  recordReceived(): void {
    this.stats.messagesReceived += 1;
  }

  /**
   * Manually set status without going through connection state (e.g. "Not logged in").
   */
  setStatusDirect(status: string): void {
    setStatus(this.hasUI, this.ui, status);
  }

  /**
   * Show a reconnection-success notification.
   */
  notifyReconnected(): void {
    notifyInfo(this.hasUI, this.ui, NOTIFICATION_RECONNECTED);
  }

  /**
   * Show an inbound mobile message notification.
   */
  notifyMobileMessage(): void {
    notifyInfo(this.hasUI, this.ui, NOTIFICATION_MOBILE_MESSAGE);
  }

  /**
   * Show a sync-failure warning (should be called at most once per session).
   */
  notifySyncFailing(): void {
    notifyWarning(this.hasUI, this.ui, NOTIFICATION_SYNC_FAILING);
  }

  /**
   * Reset message counters (e.g. on session switch).
   */
  resetStats(): void {
    this.stats.messagesSent = 0;
    this.stats.messagesReceived = 0;
    this.stats.connectedSince = null;
  }

  getCurrentState(): ConnectionState {
    return this.currentConnectionState;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private handleConnectionStateChange(state: ConnectionState): void {
    this.previousConnectionState = this.currentConnectionState;
    this.currentConnectionState = state;

    if (state === ConnectionState.Connected) {
      if (this.stats.connectedSince === null) {
        this.stats.connectedSince = Date.now();
      }

      // Notify reconnection when recovering from offline or disconnected
      if (
        this.previousConnectionState === ConnectionState.Offline ||
        this.previousConnectionState === ConnectionState.Disconnected
      ) {
        this.notifyReconnected();
      }
    } else if (state === ConnectionState.Disconnected) {
      this.stats.connectedSince = null;
    }

    this.refreshStatus();
    this.refreshWidget();
  }

  private refreshStatus(): void {
    setStatus(this.hasUI, this.ui, getConnectionStatusLabel(this.currentConnectionState));
  }

  private refreshWidget(): void {
    if (!this.hasUI || !this.sessionId) {
      return;
    }

    const lines = buildWidgetLines(
      this.sessionId,
      this.stats,
      this.currentConnectionState,
    );
    setWidget(this.hasUI, this.ui, lines);
  }

  private startWidgetLoop(): void {
    this.stopWidgetLoop();

    // Refresh widget every 10 seconds so uptime stays current
    this.widgetUpdateTimer = setInterval(() => {
      this.refreshWidget();
    }, 10_000);

    this.widgetUpdateTimer.unref?.();
    this.refreshWidget();
  }

  private stopWidgetLoop(): void {
    if (this.widgetUpdateTimer) {
      clearInterval(this.widgetUpdateTimer);
      this.widgetUpdateTimer = null;
    }
  }
}
