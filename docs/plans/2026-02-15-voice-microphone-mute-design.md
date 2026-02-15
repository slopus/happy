# Voice Microphone Mute Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to mute/unmute their microphone during an active voice session without ending the session.

**Architecture:** Extend the `VoiceSession` interface with `setMicrophoneMuted()`, add mute state to Zustand store, implement in all providers (ElevenLabs + LiveKit), and update `VoiceAssistantStatusBar` UI for both desktop (inline button) and mobile (expandable bar with action buttons).

**Tech Stack:** React Native, Zustand, ElevenLabs SDK, LiveKit SDK, Ionicons

---

### Task 1: Extend VoiceSession Interface

**Files:**
- Modify: `packages/happy-app/sources/realtime/types.ts:8-13`

**Step 1: Add `setMicrophoneMuted` to the interface**

In `packages/happy-app/sources/realtime/types.ts`, add `setMicrophoneMuted` to the `VoiceSession` interface:

```typescript
export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<void>;
    endSession(): Promise<void>;
    setMicrophoneMuted(muted: boolean): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
}
```

**Step 2: Verify TypeScript catches missing implementations**

Run: `cd packages/happy-app && yarn typecheck`
Expected: FAIL — all four provider files will error because they don't implement `setMicrophoneMuted` yet.

**Step 3: Commit**

```bash
git add packages/happy-app/sources/realtime/types.ts
git commit -m "feat(voice): add setMicrophoneMuted to VoiceSession interface"
```

---

### Task 2: Implement `setMicrophoneMuted` in ElevenLabs Providers

**Files:**
- Modify: `packages/happy-app/sources/realtime/RealtimeVoiceSession.tsx:13-90` (native)
- Modify: `packages/happy-app/sources/realtime/RealtimeVoiceSession.web.tsx:13-95` (web)

**Step 1: Add method to native ElevenLabs implementation**

In `packages/happy-app/sources/realtime/RealtimeVoiceSession.tsx`, add this method to `RealtimeVoiceSessionImpl` class (after `endSession`, before `sendTextMessage`):

```typescript
    async setMicrophoneMuted(muted: boolean): Promise<void> {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }
        try {
            await conversationInstance.setMicMuted(muted);
        } catch (error) {
            console.error('Failed to set mic muted state:', error);
        }
    }
```

**Step 2: Add method to web ElevenLabs implementation**

In `packages/happy-app/sources/realtime/RealtimeVoiceSession.web.tsx`, add the same method to `RealtimeVoiceSessionImpl` class (after `endSession`, before `sendTextMessage`):

```typescript
    async setMicrophoneMuted(muted: boolean): Promise<void> {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }
        try {
            await conversationInstance.setMicMuted(muted);
        } catch (error) {
            console.error('Failed to set mic muted state:', error);
        }
    }
```

**Step 3: Commit**

```bash
git add packages/happy-app/sources/realtime/RealtimeVoiceSession.tsx packages/happy-app/sources/realtime/RealtimeVoiceSession.web.tsx
git commit -m "feat(voice): implement setMicrophoneMuted for ElevenLabs providers"
```

---

### Task 3: Implement `setMicrophoneMuted` in LiveKit Providers

**Files:**
- Modify: `packages/happy-app/sources/realtime/HappyVoiceSession.tsx:24-155` (native)
- Modify: `packages/happy-app/sources/realtime/HappyVoiceSession.web.tsx:45-188` (web)

**Step 1: Add method to native LiveKit implementation**

In `packages/happy-app/sources/realtime/HappyVoiceSession.tsx`, add this method to `HappyVoiceSessionImpl` class (after `endSession`, before `sendTextMessage`):

```typescript
    async setMicrophoneMuted(muted: boolean): Promise<void> {
        if (!roomInstance) {
            console.warn('[HappyVoice] No active room for mute toggle');
            return;
        }
        try {
            await roomInstance.localParticipant.setMicrophoneEnabled(!muted);
        } catch (error) {
            console.error('[HappyVoice] Failed to set mic muted state:', error);
        }
    }
```

**Step 2: Add method to web LiveKit implementation**

In `packages/happy-app/sources/realtime/HappyVoiceSession.web.tsx`, add the same method to `HappyVoiceSessionImpl` class (after `endSession`, before `sendTextMessage`):

```typescript
    async setMicrophoneMuted(muted: boolean): Promise<void> {
        if (!roomInstance) {
            console.warn('[HappyVoice] No active room for mute toggle');
            return;
        }
        try {
            await roomInstance.localParticipant.setMicrophoneEnabled(!muted);
        } catch (error) {
            console.error('[HappyVoice] Failed to set mic muted state:', error);
        }
    }
```

**Step 3: Verify typecheck passes**

Run: `cd packages/happy-app && yarn typecheck`
Expected: PASS — all providers now implement the full interface.

**Step 4: Commit**

```bash
git add packages/happy-app/sources/realtime/HappyVoiceSession.tsx packages/happy-app/sources/realtime/HappyVoiceSession.web.tsx
git commit -m "feat(voice): implement setMicrophoneMuted for LiveKit providers"
```

---

### Task 4: Add Mute State to Zustand Store

**Files:**
- Modify: `packages/happy-app/sources/sync/storage.ts`

**Step 1: Add state field and setter type**

In the `StorageState` interface (around line 94-126), add after `realtimeMode`:

```typescript
    microphoneMuted: boolean;
```

And in the setters section, add after `clearRealtimeModeDebounce`:

```typescript
    setMicrophoneMuted: (muted: boolean) => void;
```

**Step 2: Add default value**

In the store initializer (around line 291-292), add after `realtimeMode: 'idle'`:

```typescript
        microphoneMuted: false,
```

**Step 3: Add setter implementation**

After `clearRealtimeModeDebounce` implementation (around line 813), add:

```typescript
        setMicrophoneMuted: (muted: boolean) => set((state) => ({
            ...state,
            microphoneMuted: muted
        })),
```

**Step 4: Add React hook**

After `useRealtimeMode` function (around line 1426), add:

```typescript
export function useMicrophoneMuted(): boolean {
    return storage(useShallow((state) => state.microphoneMuted));
}
```

**Step 5: Verify typecheck passes**

Run: `cd packages/happy-app && yarn typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/happy-app/sources/sync/storage.ts
git commit -m "feat(voice): add microphoneMuted state to Zustand store"
```

---

### Task 5: Add Mute Function to RealtimeSession Lifecycle

**Files:**
- Modify: `packages/happy-app/sources/realtime/RealtimeSession.ts`

**Step 1: Add `toggleMicrophoneMute` function**

After the `stopRealtimeSession` function (after line 119), add:

```typescript
export async function toggleMicrophoneMute() {
    if (!voiceSession || !voiceSessionStarted) {
        return;
    }

    const currentMuted = storage.getState().microphoneMuted;
    const newMuted = !currentMuted;

    try {
        await voiceSession.setMicrophoneMuted(newMuted);
        storage.getState().setMicrophoneMuted(newMuted);
    } catch (error) {
        console.error('Failed to toggle microphone mute:', error);
    }
}
```

**Step 2: Reset mute state on session stop**

In `stopRealtimeSession()`, add `storage.getState().setMicrophoneMuted(false);` after `voiceSessionStarted = false;` (line 115):

```typescript
export async function stopRealtimeSession() {
    if (!voiceSession) {
        return;
    }

    try {
        await voiceSession.endSession();
        currentSessionId = null;
        voiceSessionStarted = false;
        storage.getState().setMicrophoneMuted(false);  // NEW: reset mute on session end
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    }
}
```

**Step 3: Verify typecheck passes**

Run: `cd packages/happy-app && yarn typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/happy-app/sources/realtime/RealtimeSession.ts
git commit -m "feat(voice): add toggleMicrophoneMute and reset mute on session end"
```

---

### Task 6: Update VoiceAssistantStatusBar — Desktop (sidebar variant)

**Files:**
- Modify: `packages/happy-app/sources/components/VoiceAssistantStatusBar.tsx`

**Step 1: Add imports and state**

Add to imports at top of file:

```typescript
import { toggleMicrophoneMute } from '@/realtime/RealtimeSession';
import { useMicrophoneMuted } from '@/sync/storage';
```

Inside the component, after `const realtimeMode = useRealtimeMode();`:

```typescript
    const microphoneMuted = useMicrophoneMuted();
```

Add a mute handler:

```typescript
    const handleMuteToggle = async () => {
        try {
            await toggleMicrophoneMute();
        } catch (error) {
            console.error('Error toggling mute:', error);
        }
    };
```

**Step 2: Update sidebar variant (desktop)**

In the sidebar variant JSX (around line 152-200), add a mute button before the close icon. Replace the existing close icon `<Ionicons name="close" .../>` section with:

```tsx
                    <Pressable onPress={handleMuteToggle} hitSlop={5}>
                        <Ionicons
                            name={microphoneMuted ? "mic-off" : "mic"}
                            size={14}
                            color={statusInfo.textColor}
                            style={{ marginLeft: (isVoiceSpeaking || isVoiceThinking) ? 4 : 8 }}
                        />
                    </Pressable>

                    <Pressable onPress={handlePress} hitSlop={5}>
                        <Ionicons
                            name="close"
                            size={14}
                            color={statusInfo.textColor}
                            style={{ marginLeft: 4 }}
                        />
                    </Pressable>
```

Also update the left section mic icon to reflect mute state — change `name="mic"` to:

```tsx
                        <Ionicons
                            name={microphoneMuted ? "mic-off" : "mic"}
                            size={16}
                            color={statusInfo.textColor}
                            style={styles.micIcon}
                        />
```

Apply this mic icon change to both sidebar and full variants.

**Step 3: Verify it builds**

Run: `cd packages/happy-app && yarn typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/happy-app/sources/components/VoiceAssistantStatusBar.tsx
git commit -m "feat(voice): add mute toggle button to desktop sidebar status bar"
```

---

### Task 7: Update VoiceAssistantStatusBar — Mobile (full variant) Expandable Bar

**Files:**
- Modify: `packages/happy-app/sources/components/VoiceAssistantStatusBar.tsx`

**Step 1: Add expanded state and auto-collapse timer**

Inside the component, add state for expansion:

```typescript
    const [isExpanded, setIsExpanded] = React.useState(false);
    const collapseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const startCollapseTimer = React.useCallback(() => {
        if (collapseTimerRef.current) {
            clearTimeout(collapseTimerRef.current);
        }
        collapseTimerRef.current = setTimeout(() => {
            setIsExpanded(false);
            collapseTimerRef.current = null;
        }, 4000);
    }, []);

    const clearCollapseTimer = React.useCallback(() => {
        if (collapseTimerRef.current) {
            clearTimeout(collapseTimerRef.current);
            collapseTimerRef.current = null;
        }
    }, []);

    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (collapseTimerRef.current) {
                clearTimeout(collapseTimerRef.current);
            }
        };
    }, []);

    // Reset expanded state when disconnected
    React.useEffect(() => {
        if (realtimeStatus === 'disconnected') {
            setIsExpanded(false);
            clearCollapseTimer();
        }
    }, [realtimeStatus, clearCollapseTimer]);
```

**Step 2: Update full variant press handler and JSX**

Change the full variant `handlePress` to toggle expansion instead of stopping session. The full variant section (line 80-139) should become:

```tsx
    if (variant === 'full') {
        const handleFullPress = () => {
            if (realtimeStatus !== 'connected') {
                handlePress(); // still allow closing when error/connecting
                return;
            }
            if (isExpanded) {
                // Tap on bar while expanded = collapse
                setIsExpanded(false);
                clearCollapseTimer();
            } else {
                setIsExpanded(true);
                startCollapseTimer();
            }
        };

        const handleExpandedMuteToggle = async () => {
            await handleMuteToggle();
            // Reset collapse timer after action
            startCollapseTimer();
        };

        const handleExpandedEnd = async () => {
            setIsExpanded(false);
            clearCollapseTimer();
            await handlePress();
        };

        return (
            <View style={{
                backgroundColor: statusInfo.backgroundColor,
                width: '100%',
                overflow: 'hidden',
            }}>
                {isExpanded ? (
                    <View style={{
                        height: 64,
                        width: '100%',
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 24,
                        gap: 32,
                    }}>
                        <Pressable
                            onPress={handleExpandedMuteToggle}
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                paddingVertical: 8,
                                paddingHorizontal: 16,
                                borderRadius: 20,
                                backgroundColor: microphoneMuted ? theme.colors.status.error + '20' : 'transparent',
                            }}
                            hitSlop={10}
                        >
                            <Ionicons
                                name={microphoneMuted ? "mic-off" : "mic"}
                                size={20}
                                color={statusInfo.textColor}
                            />
                            <Text style={[styles.statusText, { color: statusInfo.textColor, marginLeft: 6 }]}>
                                {microphoneMuted ? 'Unmute' : 'Mute'}
                            </Text>
                        </Pressable>

                        <Pressable
                            onPress={handleExpandedEnd}
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                paddingVertical: 8,
                                paddingHorizontal: 16,
                                borderRadius: 20,
                            }}
                            hitSlop={10}
                        >
                            <Ionicons
                                name="close-circle"
                                size={20}
                                color={theme.colors.status.error}
                            />
                            <Text style={[styles.statusText, { color: theme.colors.status.error, marginLeft: 6 }]}>
                                End
                            </Text>
                        </Pressable>
                    </View>
                ) : (
                    <Pressable
                        onPress={handleFullPress}
                        style={{
                            height: 32,
                            width: '100%',
                            justifyContent: 'center',
                            alignItems: 'center',
                        }}
                        hitSlop={10}
                    >
                        <View style={styles.content}>
                            <View style={styles.leftSection}>
                                <StatusDot
                                    color={statusInfo.color}
                                    isPulsing={statusInfo.isPulsing}
                                    size={8}
                                    style={styles.statusDot}
                                />
                                <Ionicons
                                    name={microphoneMuted ? "mic-off" : "mic"}
                                    size={16}
                                    color={statusInfo.textColor}
                                    style={styles.micIcon}
                                />
                                <Text style={[
                                    styles.statusText,
                                    { color: statusInfo.textColor }
                                ]}>
                                    {statusInfo.text}
                                </Text>
                            </View>

                            <View style={styles.rightSection}>
                                {(isVoiceSpeaking || isVoiceThinking) && (
                                    <VoiceBars
                                        isActive
                                        color={statusInfo.textColor}
                                        size="small"
                                        mode={isVoiceThinking ? 'thinking' : 'speaking'}
                                    />
                                )}
                                <Text style={[styles.tapToEndText, { color: statusInfo.textColor, marginLeft: (isVoiceSpeaking || isVoiceThinking) ? 8 : 0 }]}>
                                    Tap for options
                                </Text>
                            </View>
                        </View>
                    </Pressable>
                )}
            </View>
        );
    }
```

**Step 3: Verify typecheck passes**

Run: `cd packages/happy-app && yarn typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/happy-app/sources/components/VoiceAssistantStatusBar.tsx
git commit -m "feat(voice): add expandable mute/end controls to mobile status bar"
```

---

### Task 8: Remove Redundant Stop from Mobile Mic Button

**Files:**
- Modify: `packages/happy-app/sources/-session/SessionView.tsx:542-564`

**Step 1: Update `handleMicrophonePress` to not stop session when connected**

Since mobile now uses the status bar to end sessions, the bottom mic button should only start sessions. When connected, pressing it does nothing (the user uses the status bar instead). Update the handler:

```typescript
    const handleMicrophonePress = React.useCallback(async () => {
        if (realtimeStatus === 'connecting') {
            return;
        }
        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            try {
                const initialPrompt = voiceHooks.onVoiceStarted(sessionId);
                await startRealtimeSession(sessionId, initialPrompt);
                tracking?.capture('voice_session_started', { sessionId });
            } catch (error) {
                console.error('Failed to start realtime session:', error);
                Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
                tracking?.capture('voice_session_error', { error: error instanceof Error ? error.message : 'Unknown error' });
            }
        } else if (realtimeStatus === 'connected') {
            // On desktop, stop session from mic button; on mobile, use status bar
            if (Platform.OS === 'web') {
                await stopRealtimeSession();
                tracking?.capture('voice_session_stopped');
                voiceHooks.onVoiceStopped();
            }
            // On mobile, do nothing — user uses the expandable status bar
        }
    }, [realtimeStatus, sessionId]);
```

**Step 2: Verify typecheck passes**

Run: `cd packages/happy-app && yarn typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/happy-app/sources/-session/SessionView.tsx
git commit -m "feat(voice): mobile mic button only starts sessions, status bar handles stop"
```

---

### Task 9: Final Typecheck and Manual Test

**Step 1: Full typecheck**

Run: `cd packages/happy-app && yarn typecheck`
Expected: PASS (ignore pre-existing `typesRaw.spec.ts` TS18048 errors)

**Step 2: Manual test checklist**

Test on desktop (web):
- [ ] Start voice session → sidebar status bar shows mic + close buttons
- [ ] Click mic button → icon changes to mic-off, audio stops transmitting
- [ ] Click mic-off → icon changes back to mic, audio resumes
- [ ] Click close → session ends, mute state resets

Test on mobile (native or emulator):
- [ ] Start voice session → status bar shows "Tap for options"
- [ ] Tap status bar → expands to show Mute + End buttons
- [ ] Tap Mute → mic-off icon, audio stops
- [ ] Tap Unmute → mic icon, audio resumes
- [ ] Tap End → session ends
- [ ] Wait 4 seconds → expanded bar auto-collapses
- [ ] Tap outside expanded bar → collapses
- [ ] When muted + collapsed → mic-off icon shows in collapsed bar

**Step 3: Commit any fixes if needed**

---

## Summary of All Files Modified

| File | Change |
|------|--------|
| `packages/happy-app/sources/realtime/types.ts` | Add `setMicrophoneMuted` to interface |
| `packages/happy-app/sources/realtime/RealtimeVoiceSession.tsx` | ElevenLabs native mute impl |
| `packages/happy-app/sources/realtime/RealtimeVoiceSession.web.tsx` | ElevenLabs web mute impl |
| `packages/happy-app/sources/realtime/HappyVoiceSession.tsx` | LiveKit native mute impl |
| `packages/happy-app/sources/realtime/HappyVoiceSession.web.tsx` | LiveKit web mute impl |
| `packages/happy-app/sources/sync/storage.ts` | Add `microphoneMuted` state + hook |
| `packages/happy-app/sources/realtime/RealtimeSession.ts` | Add `toggleMicrophoneMute` + reset on stop |
| `packages/happy-app/sources/components/VoiceAssistantStatusBar.tsx` | Desktop mute button + mobile expandable bar |
| `packages/happy-app/sources/-session/SessionView.tsx` | Mobile mic button only starts sessions |
