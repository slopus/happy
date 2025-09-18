# Tasks 1-10: Connection Management & Session Context Menu
## Detailed Implementation Breakdown for Review

---

## **FEATURE 1: Enhanced Connection & State Management**
*Critical foundation for reliable daemon control and session stability*

### **Task 1: Add daemon cleanup prompt dialog**
**Estimated Time**: 45 minutes

**Problem**: When users click "End Daemon" and it fails, they're left with no options to clean up the session.

**Current Behavior**:
- User clicks "End Daemon"
- Request fails (daemon already dead, network issue, permission error)
- Session remains in "active" state indefinitely
- No way to force cleanup

**New Behavior**:
- Show modal: "Unable to stop daemon. Remove session anyway?"
- Options: [Remove Session] [Cancel] [Force Stop]
- "Remove Session" = clean up session state locally, mark as inactive
- "Force Stop" = try alternative termination methods before giving up

**Technical Implementation**:
```typescript
// Create new modal component
interface DaemonCleanupModalProps {
  sessionId: string;
  onRemoveSession: () => void;
  onCancel: () => void;
  onForceStop: () => void;
}

// Add to existing daemon stop logic
const stopDaemon = async (sessionId: string) => {
  try {
    await apiSocket.request('/daemon/stop', { sessionId });
  } catch (error) {
    // Show cleanup modal instead of silent failure
    showDaemonCleanupModal(sessionId);
  }
};
```

**Files to Modify**:
- `sources/components/modals/DaemonCleanupModal.tsx` (new)
- `sources/sync/daemonControl.ts` (existing daemon stop logic)
- `sources/app/(app)/session/[id].tsx` (session termination UI)

---

### **Task 2: Implement connection health monitoring**
**Estimated Time**: 90 minutes

**Problem**: Users don't know when connections are failing until they try to send a message.

**Current Behavior**:
- Connection status is binary (connected/disconnected)
- No real-time health indicators
- Users discover connection issues when messages fail

**New Behavior**:
- Real-time ping/pong mechanism every 30 seconds
- Visual connection health indicators in UI
- Proactive reconnection attempts
- Connection quality indicators (excellent/good/poor/failed)

**Technical Implementation**:
```typescript
// Extend existing connection health system
class ConnectionHealthMonitor {
  private pingInterval: NodeJS.Timeout;
  private lastPongTime: number = 0;
  private connectionQuality: 'excellent' | 'good' | 'poor' | 'failed' = 'excellent';

  startMonitoring() {
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, 30000);
  }

  private sendPing() {
    const startTime = Date.now();
    apiSocket.ping().then(() => {
      const latency = Date.now() - startTime;
      this.updateConnectionQuality(latency);
    }).catch(() => {
      this.connectionQuality = 'failed';
      this.triggerReconnection();
    });
  }

  private updateConnectionQuality(latency: number) {
    if (latency < 100) this.connectionQuality = 'excellent';
    else if (latency < 500) this.connectionQuality = 'good';
    else if (latency < 2000) this.connectionQuality = 'poor';
    else this.connectionQuality = 'failed';
  }
}
```

**Files to Modify**:
- `sources/sync/connectionHealth.ts` (extend existing)
- `sources/components/ConnectionIndicator.tsx` (new UI component)
- `sources/sync/apiSocket.ts` (add ping/pong methods)
- `sources/app/(app)/_layout.tsx` (add connection indicator to header)

---

### **Task 3: Add stale connection cleanup**
**Estimated Time**: 60 minutes

**Problem**: Orphaned connections and zombie sessions accumulate over time.

**Current Behavior**:
- Sessions remain "active" even after daemon dies
- No automatic cleanup of stale connections
- Storage grows with dead session references

**New Behavior**:
- Automatic detection of zombie sessions (no activity >5 minutes)
- Background cleanup of orphaned connections
- Storage compaction for removed sessions

**Technical Implementation**:
```typescript
class StaleConnectionCleaner {
  private cleanupInterval: NodeJS.Timeout;

  startCleaning() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleConnections();
    }, 60000); // Check every minute
  }

  private cleanupStaleConnections() {
    const sessions = storage.getState().sessions;
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      if (session.active && (now - session.activeAt) > staleThreshold) {
        // Check if daemon is actually alive
        this.verifySessionAlive(sessionId).then(isAlive => {
          if (!isAlive) {
            this.markSessionInactive(sessionId);
          }
        });
      }
    }
  }

  private async verifySessionAlive(sessionId: string): Promise<boolean> {
    try {
      await apiSocket.request('/daemon/ping', { sessionId });
      return true;
    } catch {
      return false;
    }
  }
}
```

**Files to Modify**:
- `sources/sync/staleConnectionCleaner.ts` (new)
- `sources/sync/sync.ts` (integrate cleanup service)
- `sources/sync/storage.ts` (add session cleanup methods)

---

### **Task 4: Improve session state persistence**
**Estimated Time**: 75 minutes

**Problem**: Network interruptions cause loss of session state and user progress.

**Current Behavior**:
- Session state lost during network interruptions
- No local backup of session state
- Users lose unsaved work when connection drops

**New Behavior**:
- Continuous local backup of session state
- Automatic state recovery on reconnection
- Conflict resolution when local/remote state differs

**Technical Implementation**:
```typescript
class SessionStatePersistence {
  private backupInterval: NodeJS.Timeout;
  private localStateCache = new Map<string, SessionState>();

  startPersistence() {
    // Backup session state every 10 seconds
    this.backupInterval = setInterval(() => {
      this.backupCurrentState();
    }, 10000);

    // Listen for connection recovery
    apiSocket.onReconnected(() => {
      this.reconcileState();
    });
  }

  private backupCurrentState() {
    const sessions = storage.getState().sessions;
    for (const sessionId in sessions) {
      const session = sessions[sessionId];
      this.localStateCache.set(sessionId, {
        lastBackup: Date.now(),
        state: { ...session }
      });
    }
  }

  private async reconcileState() {
    for (const [sessionId, cachedState] of this.localStateCache) {
      try {
        const remoteState = await this.fetchRemoteState(sessionId);
        const reconciledState = this.mergeStates(cachedState.state, remoteState);
        storage.getState().updateSession(sessionId, reconciledState);
      } catch (error) {
        // Use cached state if remote unavailable
        storage.getState().updateSession(sessionId, cachedState.state);
      }
    }
  }
}
```

**Files to Modify**:
- `sources/sync/sessionStatePersistence.ts` (new)
- `sources/sync/storage.ts` (add state backup methods)
- `sources/sync/sync.ts` (integrate persistence service)

---

### **Task 5: Add connection timeout handling**
**Estimated Time**: 60 minutes

**Problem**: Network requests hang indefinitely without proper timeout handling.

**Current Behavior**:
- No configurable timeouts for API requests
- Requests can hang for minutes
- No retry logic for failed connections

**New Behavior**:
- Configurable timeout settings (default 30s)
- Exponential backoff retry logic
- User-friendly timeout error messages

**Technical Implementation**:
```typescript
class ConnectionTimeoutHandler {
  private defaultTimeout = 30000; // 30 seconds
  private maxRetries = 3;
  private baseDelay = 1000; // 1 second

  async requestWithTimeout<T>(
    url: string,
    options: RequestOptions,
    timeout: number = this.defaultTimeout
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        return await response.json();

      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries - 1) {
          const delay = this.baseDelay * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(`Request failed after ${this.maxRetries} attempts: ${lastError.message}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

**Files to Modify**:
- `sources/sync/connectionTimeoutHandler.ts` (new)
- `sources/sync/apiSocket.ts` (integrate timeout handling)
- `sources/sync/settings.ts` (add timeout configuration)

---

### **Task 6: Add connection state machine**
**Estimated Time**: 90 minutes

**Problem**: Connection states are unclear and transitions are not well-defined.

**Current Behavior**:
- Binary connected/disconnected state
- No clear state transitions
- Unclear UI feedback for different connection states

**New Behavior**:
- Clear state machine: connecting → connected → reconnecting → failed → offline
- Proper state transitions with validation
- State-based UI feedback and user actions

**Technical Implementation**:
```typescript
enum ConnectionState {
  OFFLINE = 'offline',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed'
}

class ConnectionStateMachine {
  private currentState: ConnectionState = ConnectionState.OFFLINE;
  private stateListeners = new Set<(state: ConnectionState) => void>();

  transition(newState: ConnectionState) {
    if (this.isValidTransition(this.currentState, newState)) {
      const oldState = this.currentState;
      this.currentState = newState;
      this.notifyListeners();
      this.handleStateEntry(newState, oldState);
    } else {
      console.warn(`Invalid transition from ${this.currentState} to ${newState}`);
    }
  }

  private isValidTransition(from: ConnectionState, to: ConnectionState): boolean {
    const validTransitions: Record<ConnectionState, ConnectionState[]> = {
      [ConnectionState.OFFLINE]: [ConnectionState.CONNECTING],
      [ConnectionState.CONNECTING]: [ConnectionState.CONNECTED, ConnectionState.FAILED],
      [ConnectionState.CONNECTED]: [ConnectionState.RECONNECTING, ConnectionState.FAILED, ConnectionState.OFFLINE],
      [ConnectionState.RECONNECTING]: [ConnectionState.CONNECTED, ConnectionState.FAILED],
      [ConnectionState.FAILED]: [ConnectionState.CONNECTING, ConnectionState.OFFLINE]
    };

    return validTransitions[from]?.includes(to) ?? false;
  }

  private handleStateEntry(state: ConnectionState, previousState: ConnectionState) {
    switch (state) {
      case ConnectionState.CONNECTING:
        this.startConnectionTimeout();
        break;
      case ConnectionState.CONNECTED:
        this.clearConnectionTimeout();
        this.startHeartbeat();
        break;
      case ConnectionState.FAILED:
        this.scheduleReconnection();
        break;
      case ConnectionState.OFFLINE:
        this.stopAllTimers();
        break;
    }
  }
}
```

**Files to Modify**:
- `sources/sync/connectionStateMachine.ts` (new)
- `sources/sync/apiSocket.ts` (integrate state machine)
- `sources/components/ConnectionStateIndicator.tsx` (new UI component)
- `sources/app/(app)/_layout.tsx` (add state indicator)

---

## **FEATURE 2: Session Management Context Menu**
*Intuitive session management with right-click/long-press functionality*

### **Task 7: Create reusable ContextMenu component**
**Estimated Time**: 90 minutes

**Problem**: No standardized way to show context menus across platforms.

**Current Behavior**:
- No context menu functionality
- Platform-specific touch/click handling inconsistent
- No reusable menu component

**New Behavior**:
- Cross-platform context menu (right-click on web/desktop, long-press on mobile)
- Consistent styling and behavior across platforms
- Accessibility support (keyboard navigation, screen readers)

**Technical Implementation**:
```typescript
interface ContextMenuOption {
  id: string;
  label: string;
  icon?: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

interface ContextMenuProps {
  options: ContextMenuOption[];
  children: React.ReactNode;
  onShow?: () => void;
  onHide?: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ options, children, onShow, onHide }) => {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handleTrigger = useCallback((event: GestureResponderEvent | MouseEvent) => {
    if (Platform.OS === 'web') {
      // Right-click on web
      event.preventDefault();
      setPosition({ x: event.clientX, y: event.clientY });
    } else {
      // Long-press on mobile
      const { pageX, pageY } = event.nativeEvent;
      setPosition({ x: pageX, y: pageY });
    }
    setVisible(true);
    onShow?.();
  }, [onShow]);

  const handleOptionPress = useCallback((option: ContextMenuOption) => {
    setVisible(false);
    onHide?.();
    option.onPress();
  }, [onHide]);

  return (
    <>
      <Pressable
        onLongPress={Platform.OS !== 'web' ? handleTrigger : undefined}
        onContextMenu={Platform.OS === 'web' ? handleTrigger : undefined}
        delayLongPress={500}
      >
        {children}
      </Pressable>

      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <Pressable
          style={styles.overlay}
          onPress={() => setVisible(false)}
        >
          <View style={[styles.menu, { left: position.x, top: position.y }]}>
            {options.map((option) => (
              <ContextMenuOption
                key={option.id}
                option={option}
                onPress={() => handleOptionPress(option)}
              />
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
};
```

**Files to Create**:
- `sources/components/ContextMenu/ContextMenu.tsx`
- `sources/components/ContextMenu/ContextMenuOption.tsx`
- `sources/components/ContextMenu/index.ts`

**Accessibility Features**:
- Screen reader announcements
- Keyboard navigation (Tab/Enter/Escape)
- High contrast support
- Focus management

---

### **Task 8: Implement session deletion with confirmation**
**Estimated Time**: 75 minutes

**Problem**: No way to delete unwanted sessions.

**Current Behavior**:
- Sessions accumulate indefinitely
- No cleanup mechanism for old sessions
- Users can't remove sessions they no longer need

**New Behavior**:
- "Delete Session" option in context menu
- Confirmation dialog with session details
- Complete cleanup including encrypted data
- Undo capability for accidental deletions

**Technical Implementation**:
```typescript
interface SessionDeleteConfirmationProps {
  session: Session;
  onConfirm: () => void;
  onCancel: () => void;
}

const SessionDeleteConfirmation: React.FC<SessionDeleteConfirmationProps> = ({
  session,
  onConfirm,
  onCancel
}) => {
  const messageCount = storage.getState().sessionMessages[session.id]?.messages.length ?? 0;
  const lastActive = new Date(session.activeAt).toLocaleDateString();

  return (
    <Modal visible={true} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <Text style={styles.title}>Delete Session?</Text>
          <Text style={styles.description}>
            This will permanently delete "{session.metadata?.name || 'Untitled Session'}"
          </Text>
          <Text style={styles.details}>
            • {messageCount} messages will be lost
            • Last active: {lastActive}
            • All encrypted data will be removed
          </Text>
          <Text style={styles.warning}>
            This action cannot be undone.
          </Text>

          <View style={styles.buttonRow}>
            <Button title="Cancel" onPress={onCancel} variant="secondary" />
            <Button title="Delete" onPress={onConfirm} variant="destructive" />
          </View>
        </View>
      </View>
    </Modal>
  );
};

const deleteSession = async (sessionId: string) => {
  try {
    // 1. Stop daemon if running
    await stopDaemon(sessionId);

    // 2. Remove encrypted data
    await storage.getState().removeSessionData(sessionId);

    // 3. Remove from server
    await apiSocket.request('/sessions/delete', { sessionId });

    // 4. Clean up local storage
    await clearSessionCache(sessionId);

    // 5. Remove from UI state
    storage.getState().removeSession(sessionId);

  } catch (error) {
    console.error('Failed to delete session:', error);
    throw error;
  }
};
```

**Files to Modify**:
- `sources/components/modals/SessionDeleteConfirmation.tsx` (new)
- `sources/sync/sessionManagement.ts` (add delete methods)
- `sources/components/SessionsList.tsx` (add context menu integration)

**Security Considerations**:
- Secure deletion of encrypted data
- Cleanup of cached decryption keys
- Removal from device keychain if applicable

---

### **Task 9: Add session duplication functionality**
**Estimated Time**: 90 minutes

**Problem**: Users can't easily create similar sessions or templates.

**Current Behavior**:
- Each session must be created from scratch
- No way to copy session configuration
- Users lose time reconfiguring similar sessions

**New Behavior**:
- "Duplicate Session" option in context menu
- Copy session metadata and initial configuration
- Generate new session ID and encryption keys
- Preserve settings but start fresh message history

**Technical Implementation**:
```typescript
const duplicateSession = async (originalSessionId: string): Promise<string> => {
  const originalSession = storage.getState().sessions[originalSessionId];
  if (!originalSession) {
    throw new Error('Original session not found');
  }

  // Generate new session ID and encryption keys
  const newSessionId = randomUUID();
  const newEncryptionKey = generateSessionKey();

  // Copy metadata with modified name
  const newMetadata = {
    ...originalSession.metadata,
    name: `${originalSession.metadata?.name || 'Untitled'} (Copy)`,
    createdAt: Date.now(),
    duplicatedFrom: originalSessionId
  };

  // Create new session
  const newSession: Session = {
    id: newSessionId,
    tag: generateSessionTag(),
    seq: 0,
    metadata: newMetadata,
    metadataVersion: 1,
    agentState: null, // Start fresh
    agentStateVersion: 0,
    active: false,
    activeAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    thinking: false,
    thinkingAt: 0,
    lastMessage: null,
    permissionMode: originalSession.permissionMode,
    modelMode: originalSession.modelMode
  };

  // Initialize encryption for new session
  await sync.encryption.initializeSession(newSessionId, newEncryptionKey);

  // Save to server
  await apiSocket.request('/sessions/create', {
    session: await encryptSessionForServer(newSession),
    encryptionKey: await sync.encryption.encryptEncryptionKey(newEncryptionKey)
  });

  // Add to local storage
  storage.getState().addSession(newSession);

  return newSessionId;
};

interface SessionDuplicationModalProps {
  originalSession: Session;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

const SessionDuplicationModal: React.FC<SessionDuplicationModalProps> = ({
  originalSession,
  onConfirm,
  onCancel
}) => {
  const [newName, setNewName] = useState(`${originalSession.metadata?.name || 'Untitled'} (Copy)`);

  return (
    <Modal visible={true} transparent animationType="slide">
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <Text style={styles.title}>Duplicate Session</Text>
          <Text style={styles.description}>
            Create a copy of "{originalSession.metadata?.name || 'Untitled Session'}"
          </Text>

          <Text style={styles.label}>New session name:</Text>
          <TextInput
            style={styles.nameInput}
            value={newName}
            onChangeText={setNewName}
            placeholder="Enter session name"
            autoFocus
          />

          <Text style={styles.copyDetails}>
            This will copy:
            • Session settings and permissions
            • Model configuration
            • Agent preferences

            This will NOT copy:
            • Message history
            • Agent state
          </Text>

          <View style={styles.buttonRow}>
            <Button title="Cancel" onPress={onCancel} variant="secondary" />
            <Button
              title="Duplicate"
              onPress={() => onConfirm(newName.trim())}
              variant="primary"
              disabled={!newName.trim()}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
};
```

**Files to Modify**:
- `sources/components/modals/SessionDuplicationModal.tsx` (new)
- `sources/sync/sessionManagement.ts` (add duplication methods)
- `sources/sync/encryption/encryption.ts` (add session key generation)

---

### **Task 10: Implement session renaming**
**Estimated Time**: 60 minutes

**Problem**: Users can't rename sessions after creation.

**Current Behavior**:
- Session names are fixed at creation
- No way to update session names
- Hard to organize sessions with meaningful names

**New Behavior**:
- "Edit Session Name" option in context menu
- Inline editing with validation
- Real-time sync across devices
- Keyboard shortcuts for quick rename

**Technical Implementation**:
```typescript
interface SessionRenameModalProps {
  session: Session;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

const SessionRenameModal: React.FC<SessionRenameModalProps> = ({
  session,
  onConfirm,
  onCancel
}) => {
  const [newName, setNewName] = useState(session.metadata?.name || '');
  const [isValid, setIsValid] = useState(true);

  const validateName = (name: string) => {
    const trimmed = name.trim();
    setIsValid(trimmed.length > 0 && trimmed.length <= 100);
  };

  const handleNameChange = (name: string) => {
    setNewName(name);
    validateName(name);
  };

  const handleConfirm = () => {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== session.metadata?.name) {
      onConfirm(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <Modal visible={true} transparent animationType="slide">
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <Text style={styles.title}>Rename Session</Text>

          <Text style={styles.label}>Session name:</Text>
          <TextInput
            style={[styles.nameInput, !isValid && styles.nameInputError]}
            value={newName}
            onChangeText={handleNameChange}
            placeholder="Enter session name"
            autoFocus
            selectTextOnFocus
            maxLength={100}
          />

          {!isValid && (
            <Text style={styles.errorText}>
              Name must be 1-100 characters long
            </Text>
          )}

          <View style={styles.buttonRow}>
            <Button title="Cancel" onPress={onCancel} variant="secondary" />
            <Button
              title="Rename"
              onPress={handleConfirm}
              variant="primary"
              disabled={!isValid || newName.trim() === session.metadata?.name}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
};

const renameSession = async (sessionId: string, newName: string) => {
  const session = storage.getState().sessions[sessionId];
  if (!session) {
    throw new Error('Session not found');
  }

  // Update metadata
  const updatedMetadata = {
    ...session.metadata,
    name: newName.trim(),
    updatedAt: Date.now()
  };

  // Encrypt and send to server
  const sessionEncryption = sync.encryption.getSessionEncryption(sessionId);
  const encryptedMetadata = await sessionEncryption.encryptMetadata(updatedMetadata);

  await apiSocket.request('/sessions/update-metadata', {
    sessionId,
    metadata: encryptedMetadata,
    metadataVersion: session.metadataVersion + 1
  });

  // Update local storage
  const updatedSession = {
    ...session,
    metadata: updatedMetadata,
    metadataVersion: session.metadataVersion + 1,
    updatedAt: Date.now()
  };

  storage.getState().updateSession(sessionId, updatedSession);
};
```

**Files to Modify**:
- `sources/components/modals/SessionRenameModal.tsx` (new)
- `sources/sync/sessionManagement.ts` (add rename methods)
- `sources/components/SessionsList.tsx` (add keyboard shortcut handling)

**UX Considerations**:
- Auto-select existing text for quick replacement
- Validate name length and characters
- Show character count for long names
- Escape key cancels, Enter confirms
- Debounced validation to avoid excessive API calls

---

## **Integration Points**

### **Context Menu Integration**
All session list items will integrate the context menu:

```typescript
// In SessionsList.tsx
const sessionContextOptions: ContextMenuOption[] = [
  {
    id: 'rename',
    label: 'Edit Session Name',
    icon: 'edit',
    onPress: () => showRenameModal(session.id)
  },
  {
    id: 'duplicate',
    label: 'Duplicate Session',
    icon: 'copy',
    onPress: () => showDuplicationModal(session.id)
  },
  {
    id: 'delete',
    label: 'Delete Session',
    icon: 'trash',
    destructive: true,
    onPress: () => showDeleteConfirmation(session.id)
  }
];

return (
  <ContextMenu options={sessionContextOptions}>
    <SessionListItem session={session} />
  </ContextMenu>
);
```

### **State Management Integration**
All tasks integrate with the existing storage and sync system:
- Connection state updates trigger UI re-renders
- Session operations sync across devices via WebSocket
- Local state persistence maintains data during interruptions

### **Error Handling**
Comprehensive error handling for all operations:
- Network failures show user-friendly messages
- Encryption errors trigger key regeneration
- Timeout errors suggest checking connection
- API errors include retry mechanisms

---

## **Testing Strategy**

### **Unit Tests Required**:
- Connection state machine transitions
- Session CRUD operations
- Encryption/decryption flows
- Timeout and retry logic

### **Integration Tests Required**:
- Cross-platform context menu behavior
- Session sync across multiple devices
- Connection recovery scenarios
- Error boundary handling

### **Manual Testing Checklist**:
- [ ] Context menu works on iOS/Android/Web
- [ ] Session deletion removes all traces
- [ ] Session duplication creates independent copies
- [ ] Session renaming syncs across devices
- [ ] Connection indicators update in real-time
- [ ] Daemon cleanup prompts appear on failures
- [ ] State persistence survives network interruptions

---

**Ready for your review and feedback!** 📝

What aspects would you like me to elaborate on or modify?