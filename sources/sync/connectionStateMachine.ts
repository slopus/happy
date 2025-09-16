/**
 * Connection state machine
 * Manages connection states with proper transitions and state-based actions
 */

export enum ConnectionState {
  OFFLINE = 'offline',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed'
}

export interface ConnectionStateContext {
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  connectionAttempts: number;
  consecutiveFailures: number;
  totalDowntime: number;
  totalUptime: number;
  errorHistory: string[];
}

export interface StateTransitionEvent {
  type: 'connect' | 'disconnect' | 'reconnect' | 'failure' | 'timeout' | 'retry' | 'reset';
  timestamp: number;
  data?: any;
  error?: Error;
}

export interface ConnectionStateConfig {
  maxConnectionAttempts: number;
  maxConsecutiveFailures: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  reconnectMultiplier: number;
  heartbeatInterval: number;
  connectionTimeout: number;
  maxErrorHistory: number;
}

const DEFAULT_CONFIG: ConnectionStateConfig = {
  maxConnectionAttempts: 5,
  maxConsecutiveFailures: 3,
  reconnectDelay: 1000,          // 1 second
  maxReconnectDelay: 30000,      // 30 seconds
  reconnectMultiplier: 2,
  heartbeatInterval: 30000,      // 30 seconds
  connectionTimeout: 10000,      // 10 seconds
  maxErrorHistory: 20
};

type StateChangeListener = (state: ConnectionState, context: ConnectionStateContext, event: StateTransitionEvent) => void;
type StateEntryHandler = (previousState: ConnectionState, context: ConnectionStateContext, event: StateTransitionEvent) => void;
type StateExitHandler = (nextState: ConnectionState, context: ConnectionStateContext, event: StateTransitionEvent) => void;

export class ConnectionStateMachine {
  private currentState: ConnectionState = ConnectionState.OFFLINE;
  private context: ConnectionStateContext;
  private config: ConnectionStateConfig;

  private stateChangeListeners = new Set<StateChangeListener>();
  private stateEntryHandlers = new Map<ConnectionState, StateEntryHandler>();
  private stateExitHandlers = new Map<ConnectionState, StateExitHandler>();

  private timers = new Map<string, NodeJS.Timeout>();

  constructor(config: Partial<ConnectionStateConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.context = {
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      connectionAttempts: 0,
      consecutiveFailures: 0,
      totalDowntime: 0,
      totalUptime: 0,
      errorHistory: []
    };

    this.setupStateHandlers();
  }

  /**
   * Get current state
   */
  getCurrentState(): ConnectionState {
    return this.currentState;
  }

  /**
   * Get current context
   */
  getContext(): ConnectionStateContext {
    return { ...this.context };
  }

  /**
   * Transition to a new state
   */
  transition(event: StateTransitionEvent): boolean {
    const newState = this.getNextState(this.currentState, event);

    if (!newState || !this.isValidTransition(this.currentState, newState)) {
      console.warn(`🔀 ConnectionStateMachine: Invalid transition from ${this.currentState} with event ${event.type}`);
      return false;
    }

    if (newState === this.currentState) {
      // Same state, just update context
      this.updateContext(event);
      return true;
    }

    const previousState = this.currentState;

    // Call exit handler for current state
    const exitHandler = this.stateExitHandlers.get(this.currentState);
    if (exitHandler) {
      exitHandler(newState, this.context, event);
    }

    // Update state and context
    this.currentState = newState;
    this.updateContext(event);

    // Call entry handler for new state
    const entryHandler = this.stateEntryHandlers.get(newState);
    if (entryHandler) {
      entryHandler(previousState, this.context, event);
    }

    // Notify listeners
    this.notifyStateChange(previousState, event);

    console.log(`🔀 ConnectionStateMachine: ${previousState} → ${newState} (${event.type})`);
    return true;
  }

  /**
   * Add state change listener
   */
  addStateChangeListener(listener: StateChangeListener): () => void {
    this.stateChangeListeners.add(listener);

    // Immediately notify with current state
    listener(this.currentState, this.getContext(), {
      type: 'connect',
      timestamp: Date.now()
    });

    return () => {
      this.stateChangeListeners.delete(listener);
    };
  }

  /**
   * Reset state machine to initial state
   */
  reset(): void {
    this.clearAllTimers();

    const resetEvent: StateTransitionEvent = {
      type: 'reset',
      timestamp: Date.now()
    };

    // Reset context
    this.context = {
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      connectionAttempts: 0,
      consecutiveFailures: 0,
      totalDowntime: 0,
      totalUptime: 0,
      errorHistory: []
    };

    // Transition to offline
    const previousState = this.currentState;
    this.currentState = ConnectionState.OFFLINE;
    this.notifyStateChange(previousState, resetEvent);
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ConnectionStateConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Determine next state based on current state and event
   */
  private getNextState(currentState: ConnectionState, event: StateTransitionEvent): ConnectionState | null {
    switch (currentState) {
      case ConnectionState.OFFLINE:
        if (event.type === 'connect') return ConnectionState.CONNECTING;
        break;

      case ConnectionState.CONNECTING:
        if (event.type === 'connect') return ConnectionState.CONNECTED;
        if (event.type === 'failure' || event.type === 'timeout') {
          return this.context.connectionAttempts >= this.config.maxConnectionAttempts
            ? ConnectionState.FAILED
            : ConnectionState.CONNECTING; // Retry
        }
        if (event.type === 'disconnect') return ConnectionState.OFFLINE;
        break;

      case ConnectionState.CONNECTED:
        if (event.type === 'disconnect') return ConnectionState.RECONNECTING;
        if (event.type === 'failure') return ConnectionState.RECONNECTING;
        break;

      case ConnectionState.RECONNECTING:
        if (event.type === 'connect') return ConnectionState.CONNECTED;
        if (event.type === 'failure' || event.type === 'timeout') {
          return this.context.consecutiveFailures >= this.config.maxConsecutiveFailures
            ? ConnectionState.FAILED
            : ConnectionState.RECONNECTING; // Keep trying
        }
        if (event.type === 'disconnect') return ConnectionState.OFFLINE;
        break;

      case ConnectionState.FAILED:
        if (event.type === 'retry') return ConnectionState.CONNECTING;
        if (event.type === 'disconnect') return ConnectionState.OFFLINE;
        break;
    }

    return null; // Invalid transition
  }

  /**
   * Check if transition is valid
   */
  private isValidTransition(from: ConnectionState, to: ConnectionState): boolean {
    const validTransitions: Record<ConnectionState, ConnectionState[]> = {
      [ConnectionState.OFFLINE]: [ConnectionState.CONNECTING],
      [ConnectionState.CONNECTING]: [ConnectionState.CONNECTED, ConnectionState.FAILED, ConnectionState.OFFLINE],
      [ConnectionState.CONNECTED]: [ConnectionState.RECONNECTING, ConnectionState.OFFLINE],
      [ConnectionState.RECONNECTING]: [ConnectionState.CONNECTED, ConnectionState.FAILED, ConnectionState.OFFLINE],
      [ConnectionState.FAILED]: [ConnectionState.CONNECTING, ConnectionState.OFFLINE]
    };

    return validTransitions[from]?.includes(to) ?? false;
  }

  /**
   * Update context based on event
   */
  private updateContext(event: StateTransitionEvent): void {
    const now = event.timestamp;

    switch (event.type) {
      case 'connect':
        if (this.currentState === ConnectionState.CONNECTED) {
          this.context.lastConnectedAt = now;
          this.context.consecutiveFailures = 0;
          this.context.connectionAttempts = 0;
        } else if (this.currentState === ConnectionState.CONNECTING) {
          this.context.connectionAttempts++;
        }
        break;

      case 'disconnect':
        this.context.lastDisconnectedAt = now;
        if (this.context.lastConnectedAt) {
          this.context.totalUptime += now - this.context.lastConnectedAt;
        }
        break;

      case 'failure':
      case 'timeout':
        this.context.consecutiveFailures++;
        this.context.connectionAttempts++;

        if (event.error) {
          this.context.errorHistory.push(`${now}: ${event.error.message}`);
          // Keep only recent errors
          if (this.context.errorHistory.length > this.config.maxErrorHistory) {
            this.context.errorHistory = this.context.errorHistory.slice(-this.config.maxErrorHistory);
          }
        }
        break;

      case 'retry':
        this.context.connectionAttempts = 0; // Reset for new attempt cycle
        break;

      case 'reset':
        // Context already reset in reset() method
        break;
    }

    // Update total downtime if offline
    if (this.context.lastDisconnectedAt && this.currentState !== ConnectionState.CONNECTED) {
      this.context.totalDowntime = now - this.context.lastDisconnectedAt;
    }
  }

  /**
   * Setup state entry and exit handlers
   */
  private setupStateHandlers(): void {
    // CONNECTING state entry
    this.stateEntryHandlers.set(ConnectionState.CONNECTING, (prevState, context, event) => {
      this.startConnectionTimeout();
    });

    // CONNECTED state entry
    this.stateEntryHandlers.set(ConnectionState.CONNECTED, (prevState, context, event) => {
      this.clearConnectionTimeout();
      this.startHeartbeat();
    });

    // RECONNECTING state entry
    this.stateEntryHandlers.set(ConnectionState.RECONNECTING, (prevState, context, event) => {
      this.scheduleReconnection();
    });

    // FAILED state entry
    this.stateEntryHandlers.set(ConnectionState.FAILED, (prevState, context, event) => {
      this.clearAllTimers();
      this.scheduleRetry();
    });

    // OFFLINE state entry
    this.stateEntryHandlers.set(ConnectionState.OFFLINE, (prevState, context, event) => {
      this.clearAllTimers();
    });

    // CONNECTED state exit
    this.stateExitHandlers.set(ConnectionState.CONNECTED, (nextState, context, event) => {
      this.clearHeartbeat();
    });
  }

  /**
   * Start connection timeout
   */
  private startConnectionTimeout(): void {
    this.clearTimer('connectionTimeout');

    const timeout = setTimeout(() => {
      this.transition({
        type: 'timeout',
        timestamp: Date.now(),
        error: new Error('Connection timeout')
      });
    }, this.config.connectionTimeout);

    this.timers.set('connectionTimeout', timeout);
  }

  /**
   * Clear connection timeout
   */
  private clearConnectionTimeout(): void {
    this.clearTimer('connectionTimeout');
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    this.clearTimer('heartbeat');

    const heartbeat = setInterval(() => {
      // Trigger heartbeat event - this could ping the server
      console.log('💓 ConnectionStateMachine: Heartbeat');
    }, this.config.heartbeatInterval);

    this.timers.set('heartbeat', heartbeat);
  }

  /**
   * Clear heartbeat
   */
  private clearHeartbeat(): void {
    this.clearTimer('heartbeat');
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnection(): void {
    this.clearTimer('reconnection');

    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(this.config.reconnectMultiplier, this.context.consecutiveFailures),
      this.config.maxReconnectDelay
    );

    const reconnection = setTimeout(() => {
      this.transition({
        type: 'connect',
        timestamp: Date.now()
      });
    }, delay);

    this.timers.set('reconnection', reconnection);
    console.log(`🔀 ConnectionStateMachine: Scheduled reconnection in ${delay}ms`);
  }

  /**
   * Schedule retry after failure
   */
  private scheduleRetry(): void {
    this.clearTimer('retry');

    // Wait longer before retrying from failed state
    const delay = this.config.maxReconnectDelay;

    const retry = setTimeout(() => {
      this.transition({
        type: 'retry',
        timestamp: Date.now()
      });
    }, delay);

    this.timers.set('retry', retry);
    console.log(`🔀 ConnectionStateMachine: Scheduled retry in ${delay}ms`);
  }

  /**
   * Clear a specific timer
   */
  private clearTimer(name: string): void {
    const timer = this.timers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(name);
    }
  }

  /**
   * Clear all timers
   */
  private clearAllTimers(): void {
    for (const [name, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Notify state change listeners
   */
  private notifyStateChange(previousState: ConnectionState, event: StateTransitionEvent): void {
    const context = this.getContext();

    for (const listener of this.stateChangeListeners) {
      try {
        listener(this.currentState, context, event);
      } catch (error) {
        console.error('🔀 ConnectionStateMachine: Error in state change listener:', error);
      }
    }
  }

  /**
   * Get human-readable state description
   */
  getStateDescription(): string {
    const attempts = this.context.connectionAttempts;
    const failures = this.context.consecutiveFailures;

    switch (this.currentState) {
      case ConnectionState.OFFLINE:
        return 'Offline';
      case ConnectionState.CONNECTING:
        return attempts > 1 ? `Connecting (attempt ${attempts})` : 'Connecting...';
      case ConnectionState.CONNECTED:
        return 'Connected';
      case ConnectionState.RECONNECTING:
        return failures > 1 ? `Reconnecting (${failures} failures)` : 'Reconnecting...';
      case ConnectionState.FAILED:
        return `Failed (${failures} consecutive failures)`;
      default:
        return 'Unknown';
    }
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    currentState: ConnectionState;
    context: ConnectionStateContext;
    config: ConnectionStateConfig;
    activeTimers: string[];
  } {
    return {
      currentState: this.currentState,
      context: this.getContext(),
      config: { ...this.config },
      activeTimers: Array.from(this.timers.keys())
    };
  }
}

// Export for use in connection health monitoring
export const connectionStateMachine = new ConnectionStateMachine();