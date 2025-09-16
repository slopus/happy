# Happy Coder v1.5.2 - Detailed Task List
## AI-Speed Development: 1-2 Days Total Implementation

### **Feature Count: 8 Major Features → 31 Detailed Tasks**

---

## **FEATURE 1: Enhanced Connection & State Management**
*Tasks 1-6 (6 tasks)*

### Task 1: Add daemon cleanup prompt dialog
- Create modal component for failed daemon stop scenarios
- Add "Unable to stop daemon. Remove session anyway?" with [Remove Session] [Cancel] [Force Stop] buttons
- Integrate with existing session termination logic

### Task 2: Implement connection health monitoring
- Extend existing connection health system
- Add real-time ping/pong mechanism with backend
- Create connection state indicators in UI

### Task 3: Add stale connection cleanup
- Implement automatic cleanup of orphaned connections
- Add connection timeout detection (30s default)
- Clean up zombie sessions from storage

### Task 4: Improve session state persistence
- Enhance session state recovery after network interruptions
- Add local state backup before network operations
- Implement session state reconciliation on reconnect

### Task 5: Add connection timeout handling
- Implement exponential backoff retry logic
- Add user-configurable timeout settings
- Create graceful degradation for offline mode

### Task 6: Add connection state machine
- Define clear connection states (connecting, connected, reconnecting, failed, offline)
- Implement proper state transitions
- Add state-based UI feedback

---

## **FEATURE 2: Session Management Context Menu**
*Tasks 7-10 (4 tasks)*

### Task 7: Create reusable ContextMenu component
- Build cross-platform context menu (right-click/long-press)
- Support iOS, Android, and Web platforms
- Add proper accessibility support

### Task 8: Implement session deletion with confirmation
- Add "Delete Session" option to context menu
- Create confirmation dialog with session details
- Implement secure session cleanup (encrypted data removal)

### Task 9: Add session duplication functionality
- Add "Duplicate Session" context menu option
- Copy session metadata and initial state
- Generate new session ID and encryption keys

### Task 10: Implement session renaming
- Add "Edit Session Name" context menu option
- Create inline editing or modal dialog
- Sync renamed sessions across devices

---

## **FEATURE 3: Enhanced Encryption with Password Protection**
*Tasks 11-16 (6 tasks)*

### Task 11: Research and implement PBKDF2 key derivation
- Add PBKDF2-SHA256 with 600,000 iterations (Bitwarden standard)
- Create password → master key derivation function
- Use email/username as salt

### Task 12: Add password protection layer
- Create password setup/entry UI flows
- Implement master key generation and storage
- Add optional anonymous username support

### Task 13: Implement secure key storage
- Integrate with platform keychains (iOS Keychain, Android Keystore, Web Crypto API)
- Add secure master key storage and retrieval
- Implement key rotation capabilities

### Task 14: Create password management UI
- Add password setup wizard for new users
- Create password change functionality
- Add password strength validation

### Task 15: Add migration system for existing users
- Create seamless migration from current TweetNaCl-only encryption
- Preserve existing encrypted data during upgrade
- Add backward compatibility mode

### Task 16: Update README with enhanced security details
- Document new encryption architecture
- Add security comparison with industry standards
- Update marketing copy to emphasize enhanced protection

---

## **FEATURE 4: Responsive UI Improvements**
*Tasks 17-19 (3 tasks)*

### Task 17: Fix "Start New" button for small screens
- Redesign button layout for screens <400px width
- Add adaptive sizing and positioning
- Test across common mobile device sizes

### Task 18: Improve responsive layout system
- Add breakpoint-based styling with Unistyles
- Optimize touch targets for mobile (44px minimum)
- Add safe area handling for modern devices

### Task 19: Enhance accessibility support
- Add screen reader compatibility
- Implement proper focus management
- Add high contrast mode support

---

## **FEATURE 5: Automatic Model Detection via MCP**
*Tasks 20-22 (3 tasks)*

### Task 20: Implement MCP client for model discovery
- Add `/mcp` endpoint integration
- Create model detection utilities
- Add error handling for MCP unavailable scenarios

### Task 21: Auto-populate model lists in settings
- Update gear "model list" with detected models
- Display model capabilities and limitations
- Add manual refresh capability

### Task 22: Add model caching and fallback
- Cache model discovery results locally
- Implement fallback to default models if MCP fails
- Add model availability status indicators

---

## **FEATURE 6: Global Permissions Settings**
*Tasks 23-25 (3 tasks)*

### Task 23: Create Global Permissions Settings UI
- Add new section to Features/Settings area
- Create 4-option permission level selector:
  - Ask for all permissions
  - Ask for dangerous permissions only
  - Allow file operations, ask for network/system
  - Allow all permissions

### Task 24: Implement permissions inheritance system
- Update new session creation to inherit global settings
- Add per-session permission override capability
- Sync global permissions across devices

### Task 25: Update existing permission system
- Extend current permission architecture
- Add global permission storage and sync
- Create permission level validation logic

---

## **FEATURE 7: Default Coder Selection**
*Tasks 26-28 (3 tasks)*

### Task 26: Add Default Coder setting UI
- Add "Default Coder" setting below Global Permissions
- Create dropdown with options: Claude Code, Codex, "Ask Each Time"
- Add explanatory text for each option

### Task 27: Update session creation logic
- Modify new session flow to use default coder automatically
- Add override option in session creation UI
- Maintain backward compatibility

### Task 28: Add coder switching capability
- Allow changing coder for existing sessions
- Add coder indicator in session list
- Implement proper session state migration

---

## **FEATURE 8: Repository File Browser**
*Tasks 29-31 (3 tasks)*

### Task 29: Add folder button to input area
- Add folder icon button next to existing "files" button at bottom of input box
- Position and style consistently with existing input controls
- Add proper accessibility labels and touch targets
- Integrate with existing input area layout and responsive design

### Task 30: Create file browser modal with tree navigation
- Build `FileBrowserModal` component with expandable folder tree
- Implement repository root detection and file system traversal
- Add file type icons and file size display
- Support expand/collapse folder functionality with smooth animations
- Add breadcrumb navigation and current path display

### Task 31: Implement file reading and markdown rendering
- Add file content reading for common text formats (.txt, .md, .js, .ts, .py, .json, .yaml)
- Create clean markdown renderer with proper styling for .md files
- Add syntax highlighting for code files
- Implement file preview modal with search and navigation
- Add recent files quick access and file filtering

---

## **📊 Implementation Timeline (AI-Speed)**

### **Day 1 (8-10 hours)**
- **Morning (3 hours)**: Tasks 1-6 (Connection & State Management)
- **Afternoon (3 hours)**: Tasks 7-10 (Session Context Menu)
- **Evening (3 hours)**: Tasks 11-13 (Encryption Foundation)

### **Day 2 (8-10 hours)**
- **Morning (3 hours)**: Tasks 14-16 (Encryption UI & Migration)
- **Afternoon (2 hours)**: Tasks 17-19 (Responsive UI)
- **Afternoon (2 hours)**: Tasks 20-22 (MCP Model Detection)
- **Evening (2 hours)**: Tasks 23-25 (Global Permissions)
- **Evening (1 hour)**: Tasks 26-28 (Default Coder)
- **Evening (1 hour)**: Tasks 29-31 (Repository File Browser)

---

## **📋 Task Dependencies**

### **Critical Path**:
1. Tasks 1-6 → Tasks 7-10 (Connection stability needed for session management)
2. Tasks 11-13 → Tasks 14-16 (Encryption foundation before UI)
3. Tasks 23-25 → Tasks 26-28 (Global permissions before default coder)

### **Parallel Development**:
- Tasks 17-19 (UI) can be done parallel to encryption work
- Tasks 20-22 (MCP) can be done independently
- Tasks 26-28 (Default Coder) can start after Task 25
- Tasks 29-31 (File Browser) can be developed independently

---

## **🎯 Success Criteria**

### **Feature 1 Complete When**:
- Daemon cleanup prompts work 100% of the time
- No stale connections remain after session termination
- Connection health indicators show real-time status
- Network interruptions auto-recover within 10 seconds

### **Feature 2 Complete When**:
- Context menu works on all platforms (iOS/Android/Web)
- Session deletion removes all encrypted data
- Session duplication creates independent copies
- Session renaming syncs across all devices

### **Feature 3 Complete When**:
- Password protection works with 600k PBKDF2 iterations
- Existing users can migrate without data loss
- Master keys stored securely in platform keychains
- README documents enhanced security architecture

### **Feature 4 Complete When**:
- "Start New" button looks good on 320px+ screens
- All touch targets meet 44px accessibility standards
- App works well on phones, tablets, and desktop

### **Feature 5 Complete When**:
- MCP model detection auto-populates gear menu
- Model list updates automatically on connection
- Graceful fallback when MCP unavailable

### **Feature 6 Complete When**:
- Global permissions settings UI is intuitive
- New sessions inherit global settings automatically
- Per-session overrides work correctly

### **Feature 7 Complete When**:
- Default coder setting applies to new sessions
- Users can change coder for existing sessions
- Session list shows current coder clearly

### **Feature 8 Complete When**:
- Folder button appears next to files button in input area
- File browser modal opens with expandable tree navigation
- Users can click to read any text file or .md file
- Markdown files render cleanly with proper formatting
- File browser shows file types, sizes, and supports search
- Recent files and breadcrumb navigation work correctly

---

## **🚀 Release Readiness Checklist**

- [ ] All 31 tasks completed and tested
- [ ] Security scanning passes (TruffleHog, GitLeaks, CodeQL)
- [ ] TypeScript compilation successful
- [ ] Mobile/web/desktop testing complete
- [ ] Documentation updated (README, SECURITY.md)
- [ ] Version bumped to 1.5.2 in version.txt
- [ ] All CI/CD workflows passing
- [ ] Performance regression testing complete

---

**Total: 8 Features → 31 Tasks → 1-2 Days Implementation**