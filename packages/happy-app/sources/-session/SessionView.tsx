import { AgentContentView } from '@/components/AgentContentView';
import { AgentInput } from '@/components/AgentInput';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';

import { useDraft } from '@/hooks/useDraft';
import { Modal } from '@/modal';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort, sessionKill, sessionDeactivate } from '@/sync/ops';
import { storage, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionMessages, useSessionUsage, useSetting, useVoiceTranscript, useVoiceContinuous } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as React from 'react';
import { useMemo } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { uploadSessionImage } from '@/sync/apiImages';
import { uploadSessionDocument, DocumentUploadResult } from '@/sync/apiDocuments';
import { TokenStorage } from '@/auth/tokenStorage';
import { AgentPreset, AGENT_PRESETS, getPresetById } from '@/-zen/model/presets';
import * as Clipboard from 'expo-clipboard';
import { createSharedSession } from '@/sync/apiShare';
import { FileBrowserPanel } from './FileBrowserPanel';
import { ResizableDivider } from '@/components/ResizableDivider';
import { PreviewPanel } from '@/components/preview/PreviewPanel';
import { ElementChip, formatElementForMessage } from '@/components/preview/ElementChip';
import { usePreviewVisible, useSelectedElement } from '@/sync/storage';

export const SessionView = React.memo((props: { id: string }) => {
    const sessionId = props.id;
    const router = useRouter();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();

    // Preset state for zen mode sessions
    const [currentPreset, setCurrentPreset] = React.useState<AgentPreset | null>(null);
    const [showPresetPicker, setShowPresetPicker] = React.useState(false);
    const [fileBrowserOpen, setFileBrowserOpen] = React.useState(false);
    const [previewOpen, setPreviewOpen] = React.useState(false);
    const [showSettingsOverlay, setShowSettingsOverlay] = React.useState(false);
    const insertTextRef = React.useRef<(text: string) => void>(null);
    const previewVisible = usePreviewVisible(sessionId);

    // Listen for toggle-file-browser event from sidebar
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === sessionId) {
                setFileBrowserOpen(prev => !prev);
            }
        };
        window.addEventListener('toggle-file-browser', handler);
        return () => window.removeEventListener('toggle-file-browser', handler);
    }, [sessionId]);

    // Listen for toggle-preview event from sidebar
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === sessionId) {
                setPreviewOpen(prev => !prev);
            }
        };
        window.addEventListener('toggle-preview', handler);
        return () => window.removeEventListener('toggle-preview', handler);
    }, [sessionId]);

    // Web swipe-back gesture (swipe right from left edge to go back)
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        let startX = 0;
        let startY = 0;
        let swiping = false;

        const handleTouchStart = (e: TouchEvent) => {
            const touch = e.touches[0];
            // Only trigger from left 30px edge
            if (touch.clientX < 30) {
                startX = touch.clientX;
                startY = touch.clientY;
                swiping = true;
            }
        };

        const handleTouchEnd = (e: TouchEvent) => {
            if (!swiping) return;
            swiping = false;
            const touch = e.changedTouches[0];
            const dx = touch.clientX - startX;
            const dy = Math.abs(touch.clientY - startY);
            // Swipe right at least 80px, mostly horizontal
            if (dx > 80 && dy < dx * 0.5) {
                router.back();
            }
        };

        window.addEventListener('touchstart', handleTouchStart, { passive: true });
        window.addEventListener('touchend', handleTouchEnd, { passive: true });
        return () => {
            window.removeEventListener('touchstart', handleTouchStart);
            window.removeEventListener('touchend', handleTouchEnd);
        };
    }, [router]);

    // Share chat — create public link and copy to clipboard
    const handleShareChat = React.useCallback(async () => {
        // Load ALL messages before sharing (pagination may have only loaded recent ones)
        let sessionMsgs = storage.getState().sessionMessages[sessionId];
        if (!sessionMsgs) return;

        while (sessionMsgs.hasMore) {
            await sync.fetchOlderMessages(sessionId);
            sessionMsgs = storage.getState().sessionMessages[sessionId];
            if (!sessionMsgs) return;
        }

        const allMessages = sessionMsgs.messages;
        const shareMessages: Array<{ role: 'user' | 'assistant'; text: string }> = [];

        // Strip <options> blocks and technical markup from shared text
        const cleanForShare = (text: string) => text.replace(/<options>[\s\S]*?<\/options>/gi, '').replace(/\n{3,}/g, '\n\n').trim();

        for (const msg of allMessages) {
            if (msg.kind === 'user-text' && msg.text) {
                shareMessages.push({ role: 'user', text: msg.text });
            } else if (msg.kind === 'agent-text' && msg.text && !msg.isThinking) {
                shareMessages.push({ role: 'assistant', text: cleanForShare(msg.text) });
            }
        }

        if (shareMessages.length === 0) return;

        try {
            const sessionName = session ? getSessionName(session) : '';
            const result = await createSharedSession({
                title: sessionName,
                sessionId,
                messages: shareMessages,
            });

            // Show modal with copy button (direct user gesture needed for clipboard on mobile web)
            Modal.alert('✓', `${result.url}`, [
                {
                    text: 'Копировать',
                    onPress: () => {
                        Clipboard.setStringAsync(result.url);
                    },
                },
                { text: 'OK', style: 'cancel' },
            ]);
        } catch (e) {
            // Fallback: copy text to clipboard
            const text = shareMessages.map(m => `**${m.role === 'user' ? 'User' : 'Assistant'}:** ${m.text}`).join('\n\n---\n\n');
            Modal.alert('⚠️', 'Не удалось создать ссылку.', [
                {
                    text: 'Копировать текст',
                    onPress: () => {
                        Clipboard.setStringAsync(text);
                    },
                },
                { text: 'OK', style: 'cancel' },
            ]);
        }
    }, [sessionId, session]);

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady) {
            // Loading state - show empty header
            return {
                title: '',
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        if (!session) {
            // Deleted state - show deleted message in header
            return {
                title: t('errors.sessionDeleted'),
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        // Normal state - show session info
        const isConnected = session.presence === 'online';
        return {
            title: getSessionName(session),
            subtitle: session.metadata?.path ? formatPathRelativeToHome(session.metadata.path, session.metadata?.homeDir) : undefined,
            avatarId: getSessionAvatarId(session),
            onAvatarPress: () => router.push(`/session/${sessionId}/info`),
            isConnected: isConnected,
            flavor: session.metadata?.flavor || null,
            tintColor: isConnected ? '#000' : '#8E8E93'
        };
    }, [session, isDataReady, sessionId, router]);

    // Split file browser state (web/tablet only)
    const useSplitMode = Platform.OS === 'web' && isTablet;
    const FILE_PANEL_STORAGE_KEY = 'happy_file_panel_width';
    const [filePanelWidth, setFilePanelWidth] = React.useState(() => {
        if (Platform.OS !== 'web') return 400;
        try {
            const saved = localStorage.getItem(FILE_PANEL_STORAGE_KEY);
            if (saved) return parseInt(saved, 10);
        } catch {}
        return 400;
    });

    const handleFilePanelResize = React.useCallback((delta: number) => {
        setFilePanelWidth(prev => {
            // Delta is positive when moving right, but we want panel to grow when moving left
            const next = Math.min(Math.max(prev - delta, 250), 800);
            return next;
        });
    }, []);

    const handleFilePanelResizeEnd = React.useCallback(() => {
        setFilePanelWidth(prev => {
            try { localStorage.setItem(FILE_PANEL_STORAGE_KEY, String(prev)); } catch {}
            return prev;
        });
    }, []);

    const showHeader = !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web');
    const contentPaddingTop = showHeader ? safeArea.top + headerHeight : 0;

    const mainContent = (
        <>
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0, left: 0, right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    shadowColor: theme.colors.shadow.color,
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: theme.colors.shadow.opacity,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Header */}
            {showHeader && (
                <View style={{
                    position: 'absolute',
                    top: 0, left: 0, right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        {...headerProps}
                        onBackPress={() => router.back()}
                        onSettingsPress={() => setShowSettingsOverlay(prev => !prev)}
                        onPreviewPress={() => setPreviewOpen(prev => !prev)}
                    />

                </View>
            )}

            {/* Content */}
            <View style={{ flex: 1, paddingTop: contentPaddingTop }}>
                {!isDataReady ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : (
                    <SessionViewLoaded key={sessionId} sessionId={sessionId} session={session} currentPreset={currentPreset} showSettingsOverlay={showSettingsOverlay} onSettingsOverlayChange={setShowSettingsOverlay} onSharePress={handleShareChat} insertTextRef={insertTextRef} />
                )}
            </View>

            {/* Preset picker overlay */}
            {showPresetPicker && (
                <Pressable
                    onPress={() => setShowPresetPicker(false)}
                    style={{
                        position: 'absolute',
                        top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.4)',
                        zIndex: 2000,
                        justifyContent: 'center',
                        alignItems: 'center',
                    }}
                >
                    <Pressable
                        onPress={(e) => e.stopPropagation()}
                        style={{
                            backgroundColor: theme.colors.surface,
                            borderRadius: 16,
                            padding: 20,
                            width: '90%',
                            maxWidth: 400,
                            maxHeight: '80%',
                        }}
                    >
                        <Text style={{
                            fontSize: 17, fontWeight: '600',
                            color: theme.colors.text,
                            marginBottom: 16,
                            textAlign: 'center',
                        }}>
                            Стиль общения
                        </Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                            <Pressable
                                onPress={() => { setCurrentPreset(null); setShowPresetPicker(false); }}
                                style={({ pressed }) => ({
                                    paddingHorizontal: 14, paddingVertical: 10,
                                    borderRadius: 12,
                                    backgroundColor: !currentPreset ? theme.colors.primary : (pressed ? theme.colors.card : theme.colors.surface),
                                    borderWidth: 1,
                                    borderColor: !currentPreset ? theme.colors.primary : theme.colors.border,
                                })}
                            >
                                <Text style={{
                                    fontSize: 14,
                                    color: !currentPreset ? '#fff' : theme.colors.text,
                                    fontWeight: '500',
                                }}>
                                    Обычный
                                </Text>
                            </Pressable>
                            {AGENT_PRESETS.map(preset => (
                                <Pressable
                                    key={preset.id}
                                    onPress={() => { setCurrentPreset(preset); setShowPresetPicker(false); }}
                                    style={({ pressed }) => ({
                                        paddingHorizontal: 14, paddingVertical: 10,
                                        borderRadius: 12,
                                        backgroundColor: currentPreset?.id === preset.id ? theme.colors.primary : (pressed ? theme.colors.card : theme.colors.surface),
                                        borderWidth: 1,
                                        borderColor: currentPreset?.id === preset.id ? theme.colors.primary : theme.colors.border,
                                    })}
                                >
                                    <Text style={{
                                        fontSize: 14,
                                        color: currentPreset?.id === preset.id ? '#fff' : theme.colors.text,
                                        fontWeight: '500',
                                    }}>
                                        {preset.emoji} {preset.titleRu}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                    </Pressable>
                </Pressable>
            )}
        </>
    );

    // Split mode (web/tablet): chat + divider + side panels
    if (useSplitMode) {
        return (
            <View style={{ flex: 1, flexDirection: 'row' }}>
                <View style={{ flex: 1 }}>
                    {mainContent}
                </View>
                {previewOpen && (
                    <>
                        <ResizableDivider onResize={handleFilePanelResize} onResizeEnd={handleFilePanelResizeEnd} />
                        <View style={{ width: filePanelWidth, borderLeftWidth: 1, borderLeftColor: theme.colors.divider }}>
                            <PreviewPanel
                                sessionId={sessionId}
                                onClose={() => setPreviewOpen(false)}
                            />
                        </View>
                    </>
                )}
                {fileBrowserOpen && (
                    <>
                        <ResizableDivider onResize={handleFilePanelResize} onResizeEnd={handleFilePanelResizeEnd} />
                        <View style={{ width: filePanelWidth, borderLeftWidth: 1, borderLeftColor: theme.colors.divider }}>
                            <FileBrowserPanel
                                visible={fileBrowserOpen}
                                onClose={() => setFileBrowserOpen(false)}
                                sessionId={sessionId}
                                workingDirectory={session?.metadata?.path || '/'}
                                mode="split"
                                onInsertText={(text) => insertTextRef.current?.(text)}
                            />
                        </View>
                    </>
                )}
            </View>
        );
    }

    // Overlay mode (mobile): original behavior
    return (
        <>
            {mainContent}
            <FileBrowserPanel
                visible={fileBrowserOpen}
                onClose={() => setFileBrowserOpen(false)}
                sessionId={sessionId}
                workingDirectory={session?.metadata?.path || '/'}
                mode="overlay"
                onInsertText={(text) => insertTextRef.current?.(text)}
            />
        </>
    );
});


function SessionViewLoaded({ sessionId, session, currentPreset, showSettingsOverlay, onSettingsOverlayChange, onSharePress, insertTextRef }: { sessionId: string, session: Session, currentPreset: AgentPreset | null, showSettingsOverlay?: boolean, onSettingsOverlayChange?: (visible: boolean) => void, onSharePress?: () => void, insertTextRef?: React.RefObject<((text: string) => void) | null> }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const [message, setMessage] = React.useState('');
    const selectedElement = useSelectedElement(sessionId);

    // Register setMessage into parent ref for FileBrowserPanel insert-to-chat
    React.useEffect(() => {
        if (insertTextRef) {
            (insertTextRef as React.MutableRefObject<((text: string) => void) | null>).current = setMessage;
            return () => {
                (insertTextRef as React.MutableRefObject<((text: string) => void) | null>).current = null;
            };
        }
    }, [insertTextRef]);
    const handleEditMessage = React.useCallback((text: string) => {
        setMessage(text);
    }, []);
    const realtimeStatus = useRealtimeStatus();
    const voiceTranscript = useVoiceTranscript();
    const voiceContinuous = useVoiceContinuous();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    // Get permission mode from session object, default to 'default'
    const permissionMode = session.permissionMode || 'default';
    // Get model mode from session object - for Gemini sessions use explicit model, default to gemini-2.5-pro
    const isGeminiSession = session.metadata?.flavor === 'gemini';
    const modelMode = session.modelMode || (isGeminiSession ? 'gemini-2.5-pro' : 'default');
    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const experiments = useSetting('experiments');

    // Sync voice transcript to input field (including clearing when voice sends)
    const prevVoiceTranscript = React.useRef(voiceTranscript);
    React.useEffect(() => {
        if (voiceTranscript !== prevVoiceTranscript.current) {
            // Only clear input if we had text before (voice cleared after send)
            if (voiceTranscript || prevVoiceTranscript.current) {
                setMessage(voiceTranscript);
            }
            prevVoiceTranscript.current = voiceTranscript;
        }
    }, [voiceTranscript]);

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    // Pending images for upload
    const [pendingImages, setPendingImages] = React.useState<Array<{ url: string; mediaType: string; width: number; height: number; localUri: string }>>([]);
    const [pendingDocuments, setPendingDocuments] = React.useState<Array<{ url: string; mediaType: string; fileName: string; fileSize: number }>>([]);
    const [isUploadingImage, setIsUploadingImage] = React.useState(false);

    // Web drag & drop and paste support
    const [isDraggingOver, setIsDraggingOver] = React.useState(false);
    const dragCounterRef = React.useRef(0);

    const uploadFileFromWeb = React.useCallback(async (file: File) => {
        const webAlert = (title: string, msg: string) => {
            if (typeof window !== 'undefined') window.alert(`${title}: ${msg}`);
            else Alert.alert(title, msg);
        };
        try {
            console.log('[file-attach] uploadFileFromWeb called:', file.name, 'type:', JSON.stringify(file.type), 'size:', file.size);
            const credentials = await TokenStorage.getCredentials();
            if (!credentials) {
                webAlert('Upload failed', 'Not authenticated');
                return;
            }

            setIsUploadingImage(true);
            const arrayBuffer = await file.arrayBuffer();
            console.log('[file-attach] arrayBuffer ready, bytes:', arrayBuffer.byteLength);

            const isImage = file.type.startsWith('image/');
            console.log('[file-attach] isImage:', isImage);

            if (isImage) {
                const mimeType = file.type || 'image/jpeg';
                const uploaded = await uploadSessionImage(credentials, sessionId, arrayBuffer, mimeType);
                console.log('[file-attach] Image upload success:', uploaded.url);
                setPendingImages(prev => [...prev, {
                    ...uploaded,
                    localUri: URL.createObjectURL(file),
                }]);
            } else {
                if (arrayBuffer.byteLength > 32 * 1024 * 1024) {
                    webAlert('Upload failed', 'File too large (max 32MB)');
                    setIsUploadingImage(false);
                    return;
                }
                const mimeType = file.type || 'application/octet-stream';
                console.log('[file-attach] Uploading document, mimeType:', mimeType, 'fileName:', file.name);
                const uploaded = await uploadSessionDocument(credentials, sessionId, arrayBuffer, mimeType, file.name);
                console.log('[file-attach] Document upload success:', JSON.stringify(uploaded));
                setPendingDocuments(prev => [...prev, uploaded]);
            }
        } catch (e: any) {
            console.error('[file-attach] Web upload FAILED:', e?.message || e, e?.stack);
            webAlert('Upload failed', e?.message || 'Failed to upload file');
        } finally {
            setIsUploadingImage(false);
        }
    }, [sessionId]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        const handleDragEnter = (e: DragEvent) => {
            e.preventDefault();
            dragCounterRef.current++;
            if (e.dataTransfer?.types?.includes('Files')) {
                setIsDraggingOver(true);
            }
        };

        const handleDragLeave = (e: DragEvent) => {
            e.preventDefault();
            dragCounterRef.current--;
            if (dragCounterRef.current === 0) {
                setIsDraggingOver(false);
            }
        };

        const handleDragOver = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
        };

        const handleDrop = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounterRef.current = 0;
            setIsDraggingOver(false);
            const files = e.dataTransfer?.files;
            if (!files) return;
            for (let i = 0; i < files.length; i++) {
                uploadFileFromWeb(files[i]);
            }
        };

        const handlePaste = (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (let i = 0; i < items.length; i++) {
                const file = items[i].getAsFile();
                if (file) {
                    e.preventDefault();
                    uploadFileFromWeb(file);
                }
            }
        };

        document.addEventListener('dragenter', handleDragEnter);
        document.addEventListener('dragleave', handleDragLeave);
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        document.addEventListener('paste', handlePaste);
        return () => {
            document.removeEventListener('dragenter', handleDragEnter);
            document.removeEventListener('dragleave', handleDragLeave);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
            document.removeEventListener('paste', handlePaste);
        };
    }, [uploadFileFromWeb]);

    // Handle file attachment (images + documents)
    // Web: single file input for images + documents
    // Attach files: single button — images + documents
    const handleAttach = React.useCallback(async () => {
        if (Platform.OS === 'web') {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*,application/pdf,text/*,.pdf,.txt,.csv,.md,.json,.yaml,.yml,.xml,.html,.py,.js,.ts,.jsx,.tsx,.java,.c,.cpp,.h,.go,.rs,.rb,.php,.swift,.kt,.sh,.sql,.toml,.ini,.cfg,.env,.log';
            input.multiple = true;
            input.style.display = 'none';
            document.body.appendChild(input);
            input.onchange = () => {
                if (input.files) {
                    for (let i = 0; i < Math.min(input.files.length, 10); i++) {
                        uploadFileFromWeb(input.files[i]);
                    }
                }
                document.body.removeChild(input);
            };
            input.click();
            return;
        }
    }, [uploadFileFromWeb]);

    const handleRemoveImage = React.useCallback((index: number) => {
        setPendingImages(prev => prev.filter((_, i) => i !== index));
    }, []);

    const handleRemoveDocument = React.useCallback((index: number) => {
        setPendingDocuments(prev => prev.filter((_, i) => i !== index));
    }, []);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [machineId, cliVersion, acknowledgedCliVersions]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo' | 'zen') => {
        storage.getState().updateSessionPermissionMode(sessionId, mode);
    }, [sessionId]);

    // Function to update model mode (for Gemini sessions)
    const updateModelMode = React.useCallback((mode: 'default' | 'gemini-2.5-pro' | 'gemini-2.5-flash' | 'gemini-2.5-flash-lite') => {
        storage.getState().updateSessionModelMode(sessionId, mode);
    }, [sessionId]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);


    // Handle microphone button tap - single phrase mode
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
            await stopRealtimeSession();
            tracking?.capture('voice_session_stopped');
            voiceHooks.onVoiceStopped();
        }
    }, [realtimeStatus, sessionId]);

    // Handle microphone long press - continuous mode (like voice messages in TG/WhatsApp)
    const handleMicrophoneLongPress = React.useCallback(async () => {
        if (realtimeStatus === 'connecting') {
            return;
        }
        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            try {
                const initialPrompt = voiceHooks.onVoiceStarted(sessionId);
                await startRealtimeSession(sessionId, initialPrompt, true);
                tracking?.capture('voice_session_started', { sessionId, mode: 'continuous' });
            } catch (error) {
                console.error('Failed to start realtime session:', error);
                Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
            }
        }
    }, [realtimeStatus, sessionId]);

    // Memoize mic button state to prevent flashing during chat transitions
    const micButtonState = useMemo(() => ({
        onMicPress: handleMicrophonePress,
        onMicLongPress: handleMicrophoneLongPress,
        isMicActive: realtimeStatus === 'connected' || realtimeStatus === 'connecting',
        isMicContinuous: voiceContinuous
    }), [handleMicrophonePress, handleMicrophoneLongPress, realtimeStatus, voiceContinuous]);

    // Kill session and archive (long press on stop button)
    const handleKillAndArchive = React.useCallback(async () => {
        try {
            // Try RPC kill first, fallback to force deactivate
            const result = await sessionKill(sessionId);
            if (!result.success) {
                const deactivateResult = await sessionDeactivate(sessionId);
                if (!deactivateResult.success) {
                    console.error('Failed to archive session:', deactivateResult.message);
                    return;
                }
            }
            // Navigate back after archiving
            if (router.canGoBack()) {
                router.back();
            } else {
                router.replace('/');
            }
        } catch (error) {
            console.error('Kill and archive failed:', error);
            // Try force deactivate as last resort
            try {
                await sessionDeactivate(sessionId);
                if (router.canGoBack()) {
                    router.back();
                } else {
                    router.replace('/');
                }
            } catch (e) {
                console.error('Force deactivate also failed:', e);
            }
        }
    }, [sessionId, router]);

    // Trigger session visibility and initialize git status sync
    React.useLayoutEffect(() => {

        // Trigger session sync
        sync.onSessionVisible(sessionId);


        // Initialize git status sync for this session
        gitStatusSync.getSync(sessionId);
    }, [sessionId, realtimeStatus]);

    let content = (
        <>
            <Deferred>
                {messages.length > 0 && (
                    <ChatList session={session} onEditMessage={handleEditMessage} />
                )}
            </Deferred>
        </>
    );
    const placeholder = messages.length === 0 ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    // Show "Continue" button after resume when Claude is waiting and last message is not from user
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    const showContinueButton = false; // Temporarily disabled

    const handleContinue = React.useCallback(() => {
        sync.sendMessage(sessionId, 'продолжай', undefined, undefined, undefined, undefined, currentPreset?.systemRole);
        trackMessageSent();
    }, [sessionId, currentPreset]);

    const input = (
        <>
            {showContinueButton && (
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingRight: 16, paddingBottom: 4 }}>
                    <Pressable
                        onPress={handleContinue}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 5,
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            borderRadius: 100,
                            backgroundColor: pressed
                                ? theme.colors.fab.backgroundPressed
                                : theme.colors.fab.background,
                        })}
                    >
                        <Ionicons name="play" size={12} color={theme.colors.fab.icon} />
                        <Text style={{ fontSize: 12, fontWeight: '500', color: theme.colors.fab.icon }}>
                            Продолжай
                        </Text>
                    </Pressable>
                </View>
            )}
            {/* Selected element chip from Preview Panel */}
            {selectedElement && (
                <View style={{ paddingHorizontal: 12, paddingTop: 6 }}>
                    <ElementChip
                        element={selectedElement}
                        onDismiss={() => storage.getState().clearSelectedElement(sessionId)}
                    />
                </View>
            )}
        <AgentInput
            placeholder={t('session.inputPlaceholder')}
            value={message}
            onChangeText={setMessage}
            sessionId={sessionId}
            permissionMode={permissionMode}
            onPermissionModeChange={updatePermissionMode}
            modelMode={modelMode as any}
            onModelModeChange={updateModelMode as any}
            metadata={session.metadata}
            connectionStatus={{
                text: sessionStatus.statusText,
                color: sessionStatus.statusColor,
                dotColor: sessionStatus.statusDotColor,
                isPulsing: sessionStatus.isPulsing
            }}
            onSend={() => {
                if (message.trim() || pendingImages.length > 0 || pendingDocuments.length > 0) {
                    const images = pendingImages.length > 0
                        ? pendingImages.map(({ url, mediaType, width, height }) => ({ url, mediaType, width, height }))
                        : undefined;
                    const documents = pendingDocuments.length > 0
                        ? pendingDocuments.map(({ url, mediaType, fileName, fileSize }) => ({ url, mediaType, fileName, fileSize }))
                        : undefined;
                    // Prepend selected element context if available
                    const elementContext = selectedElement ? formatElementForMessage(selectedElement) : '';
                    const userText = message.trim() || (images ? '[image]' : (documents ? '[document]' : ''));
                    const text = elementContext ? `${elementContext}\n${userText}` : userText;
                    setMessage('');
                    setPendingImages([]);
                    setPendingDocuments([]);
                    if (selectedElement) storage.getState().clearSelectedElement(sessionId);
                    clearDraft();
                    storage.getState().clearVoiceTranscript();
                    const isVoiceActive = realtimeStatus === 'connected' || realtimeStatus === 'connecting';
                    sync.sendMessage(sessionId, text, undefined, images, isVoiceActive ? 'voice' : undefined, documents, currentPreset?.systemRole);
                    trackMessageSent();
                    // Stop voice session after sending
                    if (isVoiceActive) {
                        stopRealtimeSession();
                    }
                }
            }}
            onAttach={handleAttach}
            pendingImages={pendingImages}
            onRemoveImage={handleRemoveImage}
            pendingDocuments={pendingDocuments}
            onRemoveDocument={handleRemoveDocument}
            isUploadingImage={isUploadingImage}
            onMicPress={micButtonState.onMicPress}
            onMicLongPress={micButtonState.onMicLongPress}
            isMicActive={micButtonState.isMicActive}
            isMicContinuous={micButtonState.isMicContinuous}
            onAbort={() => sessionAbort(sessionId)}
            onKillAndArchive={handleKillAndArchive}
            showAbortButton={sessionStatus.state === 'thinking'}
            onFileViewerPress={() => router.push(`/session/${sessionId}/files`)}
            // Autocomplete configuration
            autocompletePrefixes={['@', '/']}
            autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
            usageData={sessionUsage ? {
                inputTokens: sessionUsage.inputTokens,
                outputTokens: sessionUsage.outputTokens,
                cacheCreation: sessionUsage.cacheCreation,
                cacheRead: sessionUsage.cacheRead,
                contextSize: sessionUsage.contextSize
            } : session.latestUsage ? {
                inputTokens: session.latestUsage.inputTokens,
                outputTokens: session.latestUsage.outputTokens,
                cacheCreation: session.latestUsage.cacheCreation,
                cacheRead: session.latestUsage.cacheRead,
                contextSize: session.latestUsage.contextSize
            } : undefined}
            alwaysShowContextSize={alwaysShowContextSize}
            showSettingsExternal={showSettingsOverlay}
            onSettingsVisibilityChange={onSettingsOverlayChange}
            onSharePress={onSharePress}
        />
        </>
    );


    return (
        <>
            {/* Drag & drop overlay */}
            {isDraggingOver && Platform.OS === 'web' && (
                <View style={{
                    position: 'absolute',
                    top: 0, left: 0, right: 0, bottom: 0,
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    zIndex: 9999,
                    alignItems: 'center',
                    justifyContent: 'center',
                }} pointerEvents="none">
                    <View style={{
                        backgroundColor: theme.colors.surface,
                        borderRadius: 16,
                        paddingHorizontal: 32,
                        paddingVertical: 24,
                        alignItems: 'center',
                        borderWidth: 2,
                        borderColor: theme.colors.textLink,
                        borderStyle: 'dashed',
                    }}>
                        <Ionicons name="attach-outline" size={40} color={theme.colors.textLink} />
                        <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600', marginTop: 8 }}>
                            Drop file here
                        </Text>
                    </View>
                </View>
            )}
            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: '#FFF3CD',
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.15,
                        shadowRadius: 4,
                        elevation: 4,
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color="#FF9500" style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: '#856404',
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color="#856404" style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{ flexBasis: 0, flexGrow: 1, paddingBottom: safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 32 : 0) }}>
                <AgentContentView
                    content={content}
                    input={input}
                    placeholder={placeholder}
                />
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: `rgba(${theme.dark ? '28, 23, 28' : '255, 255, 255'}, 0.9)`,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.1,
                                    shadowRadius: 4,
                                },
                                android: {
                                    elevation: 2,
                                }
                            }),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color="#000"
                        />
                    </Pressable>
                )
            }

        </>
    )
}
