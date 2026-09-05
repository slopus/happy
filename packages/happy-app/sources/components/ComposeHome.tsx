import * as React from 'react';
import { View, Text, Pressable, Platform, ScrollView, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter, useNavigation, useLocalSearchParams } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Header } from './navigation/Header';
import { layout } from './layout';
import { MessageComposer } from './MessageComposer';
import type { MultiTextInputHandle } from './MultiTextInput';
import { SessionConfigPanel, type SessionConfigPanelHandle } from './SessionConfigPanel';
import { ComposeHomeParticles } from './ComposeHomeParticles';
import { useIsTablet } from '@/utils/responsive';
import {
    DESKTOP_MAIN_MIN_WIDTH,
    getPersistentHeaderContentInset,
    getDesktopRightPanelPresentation,
    getPersistentNavigationControlsWidth,
    PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
    TAURI_HEADER_CONTROL_LEFT,
} from '@/utils/desktopNavigationLayout';
import { isTauri } from '@/utils/isTauri';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { storage, useProfile, useAllMachines, useIsDataReady, useLocalSetting, useLocalSettingMutable, useSetting, useSettingMutable } from '@/sync/storage';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useSpawnSession } from '@/hooks/useSpawnSession';
import { useComposeDraft } from '@/sync/composeDraft';
import { useImagePicker } from '@/hooks/useImagePicker';
import { getDisplayName, getAvatarUrl } from '@/sync/profile';
import { Avatar } from './Avatar';
import { RightSwipePanelHost, useRightSwipePanel } from './RightSwipePanelHost';
import { SessionCapabilityHub } from './rightPanel/SessionCapabilityHub';
import { DesktopRightPanel, DesktopRightPanelToggleButton } from './DesktopRightPanel';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveNewSessionModeSelection } from '@/utils/newSessionModeSelection';
import { resolveNewSessionSpawnSettings } from '@/utils/newSessionSpawnSettings';
import {
    getCodingAgentPickerItems,
    getComposeHomeExperience,
    getHeaderModeSwitchExperience,
    selectAgentForTopLevelMode,
    type NewSessionTopLevelMode,
} from '@/utils/newSessionExperience';
import type { NewSessionAgentType } from '@/sync/persistence';
import { useShallow } from 'zustand/react/shallow';
import { hapticsLight } from './haptics';
import {
    MAX_IMAGE_AGENT_VARIANTS_PER_STYLE,
    buildImageAgentPrompt,
    getImageAgentStyleOptionsForAgent,
    getImageAgentStyleLabel,
    getImageAgentStylesForAgent,
    getImageAgentVariantCount,
    shouldUseUserImageStyleReferenceImages,
    USER_IMAGE_STYLE_ID_PREFIX,
    type ImageAgentStylePreset,
} from './agents/imageAgentPrompt';
import { IMAGE_STYLE_COMPOSE_ROUTE, resolveComposeImageAgent, setImageAgentStyles, setImageAgentVariantCount, toggleImageAgentStyle } from './agents/imageAgentMode';
import { ImageStyleGallerySheet } from './agents/ImageStyleGallerySheet';
import { createAppBuilderAgent } from './agents/builtinAgents';
import { buildCustomImageStyleAnalysisPrompt, parseStylePromptExtractionFromMessage } from './agents/customImageStyleAnalysis';
import { normalizeImageForUpload } from '@/utils/normalizeImageForUpload';
import type { UserImageStyle } from './agents/imageStyleTypes';
import { buildAskApiEnvironment, isAskApiConfigured } from '@/utils/askApiConfig';
import { Modal } from '@/modal';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { machineSpawnNewSession, sessionArchive } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { useDesktopWorkspaceLayout } from '@/hooks/useDesktopWorkspaceLayout';
import { useDesktopSettingsModal } from './DesktopSettingsModal';
import { useGeneratedImagesPlugin } from '@/hooks/useGeneratedImagesPlugin';

// Agent display labels for the compose chip. Mirrors the list used in /new.
const AGENT_LABELS: Record<string, string> = {
    ask: 'ask',
    claude: 'claude code',
    codex: 'codex',
    opencode: 'opencode',
    openclaw: 'openclaw',
    gemini: 'gemini',
};

const HEADER_MODE_AGENT_OPTIONS: { key: NewSessionAgentType; label: string }[] = [
    { key: 'opencode', label: AGENT_LABELS.opencode },
    { key: 'claude', label: AGENT_LABELS.claude },
    { key: 'codex', label: AGENT_LABELS.codex },
    { key: 'openclaw', label: AGENT_LABELS.openclaw },
    { key: 'gemini', label: AGENT_LABELS.gemini },
];

const HEADER_MODE_SWITCH_ITEMS: { key: NewSessionTopLevelMode; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'ask', icon: 'chatbubble-ellipses-outline' },
    { key: 'agent', icon: 'terminal-outline' },
];

/**
 * Compose-first new-session page. A greeting and a real text input with every
 * editable launch setting kept in its footer. Sending spawns a session inline
 * via useSpawnSession. It only spawns when the target is
 * actually reachable — a selected, online machine and no fresh-worktree request;
 * otherwise the send button stays disabled (greyed) rather than bouncing
 * elsewhere. Creating a new worktree / spawning on an offline machine is not
 * supported here.
 *
 * 两种模式：
 *  - 'home'（默认）：主首页；手机布局左侧显示会话抽屉按钮，所有布局右侧显示设置头像。
 *  - 'screen'：作为 `/new` 路由打开；手机布局显示局部返回按钮，桌面布局使用持久导航控件。
 */
type ComposeHomeProps = {
    variant?: 'home' | 'screen';
};

type SubmittedComposeSnapshot = {
    text: string;
    textRevision: number;
    userAttachmentIds: string[];
};

const CompactRightPanelToggleButton = React.memo(function CompactRightPanelToggleButton({
    panelLabel,
}: {
    panelLabel: string;
}) {
    const panel = useRightSwipePanel();
    if (!panel) return null;

    return (
        <DesktopRightPanelToggleButton
            expanded={panel.isOpen}
            label={panel.isOpen
                ? t('desktopWorkspace.hidePanel', { panel: panelLabel })
                : t('desktopWorkspace.showPanel', { panel: panelLabel })}
            onPress={panel.isOpen ? () => panel.closePanel() : panel.openPanel}
        />
    );
});

export const ComposeHome = React.memo(({ variant = 'home' }: ComposeHomeProps) => {
    const isScreen = variant === 'screen';
    const { theme } = useUnistyles();
    const { openSettings: showSettings } = useDesktopSettingsModal();
    const router = useRouter();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
    const profile = useProfile();
    const machines = useAllMachines();
    const isDataReady = useIsDataReady();
    React.useEffect(() => {
        if (!isDataReady) return;
        const timer = setTimeout(() => { void sync.sessionRouteBecameInteractive(); }, 0);
        return () => clearTimeout(timer);
    }, [isDataReady]);
    const askApi = useLocalSetting('askApi');
    const zenMode = useLocalSetting('zenMode');
    const [desktopRightPanelCollapsed, setDesktopRightPanelCollapsed] = useLocalSettingMutable('desktopRightPanelCollapsed');
    const {
        leftVisible: desktopLeftSidebarVisible,
        leftWidth: desktopLeftSidebarWidth,
        rightPanelAvailable: desktopRightPanelAvailable,
        rightExpandedWidth: desktopRightPanelExpandedWidth,
        rightWidth: desktopRightPanelWidth,
    } = useDesktopWorkspaceLayout();
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const { sending, hydrationError, retryHydration, spawn } = useSpawnSession();
    const { text, setText, images: draftImages, setImages: setDraftImages } = useComposeDraft();
    const pendingSubmissionRef = React.useRef<SubmittedComposeSnapshot | null>(null);
    const [imageGalleryOpen, setImageGalleryOpen] = React.useState(false);
    const [selectedImageStyleIds, setSelectedImageStyleIds] = React.useState<string[]>([]);
    const [selectedImageVariantCount, setSelectedImageVariantCount] = React.useState(1);
    const composerInputRef = React.useRef<MultiTextInputHandle>(null);
    const configPanelRef = React.useRef<SessionConfigPanelHandle>(null);

    // 当从「我的 Agent」启动器进入时，路由带 ?agentId=<id>。据此查出对应 Agent，
    // 用于显示个性化问候 + 预设提示词；查不到（或无该参数）时一切退化为默认行为。
    const { agentId, mode, sidebarListId } = useLocalSearchParams<{ agentId?: string; mode?: string; sidebarListId?: string }>();
    const agents = useLocalSetting('agents');
    const { status: generatedImagesPluginStatus } = useGeneratedImagesPlugin();
    const imagePluginInstalled = generatedImagesPluginStatus?.installed === true;
    const [customImageStyles, setCustomImageStyles] = useSettingMutable('customImageStyles');
    const [pendingCustomImageStyleReferences, setPendingCustomImageStyleReferences] = useSettingMutable('pendingCustomImageStyleReferences');
    const customImageStylesRef = React.useRef(customImageStyles);
    React.useEffect(() => {
        customImageStylesRef.current = customImageStyles;
    }, [customImageStyles]);
    const activeAgent = React.useMemo(
        () => (agentId ? agents.find((a) => a.id === agentId) ?? null : null),
        [agentId, agents],
    );
    const imageAgent = React.useMemo(
        () => resolveComposeImageAgent({
            routeMode: mode,
            agent: activeAgent,
            imagePluginInstalled,
        }),
        [activeAgent, imagePluginInstalled, mode],
    );
    const effectiveImageAgent = React.useMemo(
        () => (imageAgent
            ? setImageAgentVariantCount(setImageAgentStyles(imageAgent, selectedImageStyleIds), selectedImageVariantCount)
            : null),
        [imageAgent, selectedImageStyleIds, selectedImageVariantCount],
    );
    const activeImageAgent = !!imageAgent;
    const galleryImageStyles = React.useMemo(
        () => (imageAgent ? getImageAgentStyleOptionsForAgent(imageAgent, customImageStyles) : []),
        [imageAgent, customImageStyles],
    );
    const activeImageStyles = React.useMemo(
        () => (effectiveImageAgent && selectedImageStyleIds.length > 0
            ? getImageAgentStylesForAgent(effectiveImageAgent, customImageStyles)
            : []),
        [effectiveImageAgent, selectedImageStyleIds.length, customImageStyles],
    );
    const selectedCustomReferenceImages = React.useMemo<AttachmentPreview[]>(() => {
        const selectedIds = new Set(activeImageStyles.map((style) => style.id));
        const references = customImageStyles
            .filter((style) => selectedIds.has(style.id) && shouldUseUserImageStyleReferenceImages(style))
            .flatMap((style) => style.referenceImages);
        return references.map((image) => ({
            id: `style_${image.id}`,
            uri: image.uri,
            width: image.width,
            height: image.height,
            mimeType: image.mimeType,
            size: image.size,
            name: image.name,
            thumbhash: image.thumbhash,
        }));
    }, [activeImageStyles, customImageStyles]);
    const activeImageVariants = effectiveImageAgent ? getImageAgentVariantCount(effectiveImageAgent) : 1;
    const imageEffectTitle = React.useMemo(() => {
        if (activeImageStyles.length === 1) {
            return getImageAgentStyleLabel(activeImageStyles[0]);
        }
        if (activeImageStyles.length > 1) {
            return t('agents.imageAgentSummary', { count: activeImageStyles.length, variants: activeImageVariants });
        }
        return t('agents.imageEffectChoose');
    }, [activeImageStyles, activeImageVariants]);

    React.useEffect(() => {
        const initialStyleIds = activeAgent?.kind === 'image-styles' && imageAgent
            ? getImageAgentStylesForAgent(imageAgent, customImageStyles).map((style) => style.id)
            : [];
        setSelectedImageStyleIds(initialStyleIds);
        setSelectedImageVariantCount(imageAgent ? getImageAgentVariantCount(imageAgent) : 1);
        setImageGalleryOpen(false);
    }, [activeAgent?.id, imageAgent?.id, imageAgent?.imageStyleIds, imageAgent?.imageVariantsPerStyle]);

    // 预设提示词「填充」走 MessageComposer 转发出来的命令式 ref：输入框是非受控的
    // （MultiTextInput 用 defaultValue 播种），setText 只改父级状态、看不见。调用
    // setTextAndSelection 才会真正改写原生输入框，并回调 onChangeText 同步父级 text
    // 与发送按钮的 hasText 状态。随后 focus 让光标落到末尾，但不自动发送。
    const fillPreset = React.useCallback((prompt: string) => {
        hapticsLight();
        const len = prompt.length;
        composerInputRef.current?.setTextAndSelection(prompt, { start: len, end: len });
        composerInputRef.current?.focus();
    }, []);

    const { agentType, selectedMachineId, worktreeKey, setAgentType } = useNewSessionDraft(useShallow((s) => ({
        agentType: s.agentType,
        selectedMachineId: s.selectedMachineId,
        worktreeKey: s.worktreeKey,
        setAgentType: s.setAgentType,
    })));
    const selectedPath = useNewSessionDraft(s => s.selectedPath);

    React.useEffect(() => {
        if (activeImageAgent && agentType !== 'codex') {
            setAgentType('codex');
        }
    }, [activeImageAgent, agentType, setAgentType]);

    // Inline image attachments (claude / codex). 图片上传已转正：Claude、Codex 会话默认
    // 显示图片按钮，不再依赖实验开关。两者的 runner 都会把附件转发给模型（见 sync.ts
    // supportsAttachments），其余 runner（gemini / openclaw）会静默丢弃，故不显示。
    // compact horizontal strip keeps the footprint to one row.
    const composeExperience = React.useMemo(
        () => getComposeHomeExperience({ agentType, activeImageAgent, imagePluginInstalled }),
        [activeImageAgent, agentType, imagePluginInstalled],
    );
    const canAttach = composeExperience.canAttach;
    const { selectedImages, pickImages, pickAttachment, removeImage, clearImages, addImages } = useImagePicker({
        selection: { images: draftImages, setImages: setDraftImages },
    });
    const selectedImagesRef = React.useRef(selectedImages);
    selectedImagesRef.current = selectedImages;
    const hasImages = canAttach && selectedImages.length > 0;
    const pendingStyleImageRestoreState = React.useRef<'idle' | 'restoring' | 'done'>('idle');

    React.useEffect(() => {
        if (!activeImageAgent) {
            pendingStyleImageRestoreState.current = 'idle';
            return;
        }
        if (pendingStyleImageRestoreState.current === 'idle') {
            if (pendingCustomImageStyleReferences.length > 0 && selectedImages.length === 0) {
                pendingStyleImageRestoreState.current = 'restoring';
                addImages(pendingCustomImageStyleReferences);
                return;
            }
            pendingStyleImageRestoreState.current = 'done';
            return;
        }
        if (pendingStyleImageRestoreState.current === 'restoring' && selectedImages.length > 0) {
            pendingStyleImageRestoreState.current = 'done';
        }
    }, [activeImageAgent, pendingCustomImageStyleReferences, selectedImages.length, addImages]);

    React.useEffect(() => {
        if (!activeImageAgent || pendingStyleImageRestoreState.current !== 'done') return;
        setPendingCustomImageStyleReferences(selectedImages.map((image) => ({
            id: image.id,
            uri: image.uri,
            width: image.width,
            height: image.height,
            mimeType: image.mimeType,
            size: image.size,
            name: image.name,
            thumbhash: image.thumbhash,
        })));
    }, [activeImageAgent, selectedImages, setPendingCustomImageStyleReferences]);

    const name = getDisplayName(profile);
    const selectedMachine = React.useMemo(
        () => machines.find((m) => m.id === selectedMachineId),
        [machines, selectedMachineId],
    );
    const builtinAppAgent = React.useMemo(() => createAppBuilderAgent({
        machines,
        preferredMachineId: selectedMachineId,
        preferredPath: selectedPath,
        title: t('agents.appBuilderTitle'),
        presetBuildLabel: t('agents.appBuilderPresetBuild'),
        presetBugfixLabel: t('agents.appBuilderPresetBugfix'),
    }), [machines, selectedMachineId, selectedPath]);
    const displayAgent = React.useMemo(() => {
        if (!agentId) return null;
        return agents.find((a) => a.id === agentId) ?? (builtinAppAgent?.id === agentId ? builtinAppAgent : null);
    }, [agentId, agents, builtinAppAgent]);
    const online = selectedMachine ? isMachineOnline(selectedMachine) : false;
    const headerModeSwitchExperience = React.useMemo(
        () => getHeaderModeSwitchExperience({
            agentType,
            activeImageAgent,
            askConfigured: isAskApiConfigured(askApi),
        }),
        [activeImageAgent, agentType, askApi],
    );
    const availableCodingAgents = React.useMemo(() => {
        const availability = selectedMachine?.metadata?.cliAvailability;
        const codingAgents = getCodingAgentPickerItems(HEADER_MODE_AGENT_OPTIONS);
        if (!availability) return codingAgents;
        return codingAgents.filter((agent) => availability[agent.key]);
    }, [selectedMachine]);

    const openDrawer = React.useCallback(() => {
        navigation.dispatch(DrawerActions.openDrawer());
    }, [navigation]);

    const openSettings = React.useCallback(() => {
        showSettings();
    }, [showSettings]);

    const goBack = React.useCallback(() => {
        if (router.canGoBack()) {
            router.back();
            return;
        }
        router.replace('/');
    }, [router]);

    const openImageStyleMode = React.useCallback(() => {
        hapticsLight();
        router.push(IMAGE_STYLE_COMPOSE_ROUTE as any);
    }, [router]);

    const openImageStyleGallery = React.useCallback(() => {
        hapticsLight();
        setImageGalleryOpen(true);
    }, []);

    const closeImageStyleGallery = React.useCallback(() => {
        setImageGalleryOpen(false);
    }, []);

    const toggleImageStyleFromGallery = React.useCallback((style: ImageAgentStylePreset) => {
        hapticsLight();
        setSelectedImageStyleIds((current) => (
            toggleImageAgentStyle(setImageAgentStyles(imageAgent!, current), style.id).imageStyleIds
        ));
    }, [imageAgent]);

    const setImageDrawCount = React.useCallback((count: number) => {
        hapticsLight();
        setSelectedImageVariantCount(count);
    }, []);

    const updateCustomImageStyle = React.useCallback((id: string, updater: (style: UserImageStyle) => UserImageStyle) => {
        const next = customImageStylesRef.current.map((style) => style.id === id ? updater(style) : style);
        customImageStylesRef.current = next;
        setCustomImageStyles(next);
    }, [setCustomImageStyles]);

    const processedCustomAnalysisSessionsRef = React.useRef(new Set<string>());
    const customAnalysisSnapshotText = storage((state) => JSON.stringify(customImageStyles
        .filter((style) => style.analysisStatus === 'analyzing' && !!style.analysisSessionId)
        .map((style) => {
            const sessionId = style.analysisSessionId!;
            const session = state.sessions[sessionId];
            const messages = state.sessionMessages[sessionId]?.messages ?? [];
            const agentText = messages
                .flatMap((message) => (message.kind === 'agent-text' && !message.isThinking ? [message.text] : []))
                .join('\n');
            return {
                styleId: style.id,
                sessionId,
                agentText,
                thinking: session?.thinking ?? false,
                active: session?.active ?? false,
            };
        })));

    React.useEffect(() => {
        const customAnalysisSnapshots = JSON.parse(customAnalysisSnapshotText) as Array<{
            styleId: string;
            sessionId: string;
            agentText: string;
            thinking: boolean;
            active: boolean;
        }>;
        for (const snapshot of customAnalysisSnapshots) {
            if (processedCustomAnalysisSessionsRef.current.has(snapshot.sessionId)) continue;
            if (!snapshot.agentText.trim()) continue;
            const extracted = parseStylePromptExtractionFromMessage(snapshot.agentText);
            if (!extracted) {
                if (!snapshot.active && !snapshot.thinking) {
                    processedCustomAnalysisSessionsRef.current.add(snapshot.sessionId);
                    updateCustomImageStyle(snapshot.styleId, (current) => ({
                        ...current,
                        analysisStatus: 'failed',
                        analysisError: t('agents.customImageStyleInvalidLocalResult'),
                        updatedAt: Date.now(),
                    }));
                    sessionArchive(snapshot.sessionId).catch(() => undefined);
                }
                continue;
            }

            processedCustomAnalysisSessionsRef.current.add(snapshot.sessionId);
            updateCustomImageStyle(snapshot.styleId, (current) => ({
                ...current,
                promptHint: extracted.summary || current.promptHint,
                promptContent: extracted.promptContent,
                negativePrompt: extracted.negativePrompt || undefined,
                tags: extracted.tags,
                analysisStatus: 'prompt-ready',
                analysisError: undefined,
                analyzedAt: Date.now(),
                promptSource: 'extracted-prompt',
                updatedAt: Date.now(),
            }));
            sessionArchive(snapshot.sessionId).catch(() => undefined);
        }
    }, [customAnalysisSnapshotText, updateCustomImageStyle]);

    const analyzeCustomImageStyle = React.useCallback(async (style: UserImageStyle) => {
        updateCustomImageStyle(style.id, (current) => ({
            ...current,
            analysisStatus: 'analyzing',
            analysisError: undefined,
            updatedAt: Date.now(),
        }));

        if (!selectedMachineId || !selectedMachine || !isMachineOnline(selectedMachine)) {
            updateCustomImageStyle(style.id, (current) => ({
                ...current,
                analysisStatus: 'failed',
                analysisError: t('agents.customImageStyleMissingLocalAgent'),
                updatedAt: Date.now(),
            }));
            return;
        }

        // Normalize + validate the reference images BEFORE spawning a Codex session.
        // The CLI drops any attachment that isn't a vision-readable format, so a style
        // built from HEIC references would otherwise spawn a session that silently
        // receives no images and returns a confusing "no reference image detected".
        // Doing it here also repairs older styles whose references predate the fix.
        const attachments: AttachmentPreview[] = [];
        for (const image of style.referenceImages) {
            try {
                const normalized = await normalizeImageForUpload(image.uri, image.width, image.height);
                attachments.push({
                    id: image.id,
                    uri: normalized.uri,
                    width: normalized.width,
                    height: normalized.height,
                    mimeType: normalized.mimeType,
                    size: normalized.size,
                    name: image.name,
                    thumbhash: image.thumbhash,
                });
            } catch {
                // Unreadable/unconvertible reference — skip it.
            }
        }

        if (attachments.length === 0) {
            updateCustomImageStyle(style.id, (current) => ({
                ...current,
                analysisStatus: 'failed',
                analysisError: t('agents.customImageStyleNoReadableImages'),
                updatedAt: Date.now(),
            }));
            return;
        }

        try {
            const pathToUse = (selectedPath ?? '').trim() || '~';
            const absolutePath = resolveAbsolutePath(pathToUse, selectedMachine.metadata?.homeDir);
            const spawnDirectory = (worktreeKey && worktreeKey !== '__none__' && worktreeKey !== '__new__')
                ? worktreeKey
                : absolutePath;
            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: spawnDirectory,
                agent: 'codex',
            });
            if (result.type !== 'success') {
                throw new Error(result.type === 'error' ? result.errorMessage : t('agents.customImageStyleMissingLocalAgent'));
            }
            await sync.refreshSessions();
            updateCustomImageStyle(style.id, (current) => ({
                ...current,
                analysisSessionId: result.sessionId,
                analysisError: undefined,
                updatedAt: Date.now(),
            }));
            await sync.sendMessage(result.sessionId, buildCustomImageStyleAnalysisPrompt(style.title), {
                source: 'new_session',
                attachments,
                displayText: t('agents.customImageStyleAnalysisTaskMessage', { name: style.title, count: attachments.length }),
            });
        } catch (error) {
            updateCustomImageStyle(style.id, (current) => ({
                ...current,
                analysisStatus: 'failed',
                analysisError: error instanceof Error ? error.message : t('agents.customImageStyleAnalysisFailed'),
                updatedAt: Date.now(),
            }));
        }
    }, [selectedMachineId, selectedMachine, selectedPath, worktreeKey, updateCustomImageStyle]);

    const createCustomImageStyle = React.useCallback(async () => {
        if (!activeImageAgent || selectedImages.length === 0) return;
        hapticsLight();
        const defaultName = t('agents.customImageStyleDefaultName');
        const title = (await Modal.prompt(
            t('agents.customImageStyleCreateTitle'),
            t('agents.customImageStyleCreateMessage'),
            {
                placeholder: defaultName,
                defaultValue: defaultName,
                confirmText: t('agents.customImageStyleCreateConfirm'),
            },
        ))?.trim();
        if (!title) return;

        const now = Date.now();
        const id = `${USER_IMAGE_STYLE_ID_PREFIX}${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const referenceImages = selectedImages.slice(0, 6).map((image, index) => ({
            id: `${id}-${index}`,
            uri: image.uri,
            width: image.width,
            height: image.height,
            mimeType: image.mimeType,
            size: image.size,
            name: image.name,
            thumbhash: image.thumbhash,
        }));
        const promptHint = t('agents.customImageStylePromptHint', { name: title });
        const newStyle = {
            id,
            title,
            promptHint,
            tags: [] as string[],
            analysisStatus: 'analyzing' as const,
            promptSource: 'reference-image' as const,
            referenceImages,
            createdAt: now,
            updatedAt: now,
        };

        const nextStyles = [
            newStyle,
            ...customImageStyles.filter((style) => style.id !== id),
        ].slice(0, 24);
        customImageStylesRef.current = nextStyles;
        setCustomImageStyles(nextStyles);
        setSelectedImageStyleIds([id]);
        setPendingCustomImageStyleReferences([]);
        clearImages();
        setImageGalleryOpen(false);
        analyzeCustomImageStyle(newStyle);
    }, [activeImageAgent, selectedImages, setCustomImageStyles, customImageStyles, setPendingCustomImageStyleReferences, clearImages, analyzeCustomImageStyle]);

    const retryCustomImageStyleAnalysis = React.useCallback((style: ImageAgentStylePreset) => {
        const customStyle = customImageStylesRef.current.find((item) => item.id === style.id);
        if (!customStyle) return;
        hapticsLight();
        analyzeCustomImageStyle(customStyle);
    }, [analyzeCustomImageStyle]);

    const deleteCustomImageStyle = React.useCallback(async (style: ImageAgentStylePreset) => {
        if (!style.custom) return;
        hapticsLight();
        const confirmed = await Modal.confirm(
            t('agents.customImageStyleDeleteTitle'),
            t('agents.customImageStyleDeleteMessage', { name: getImageAgentStyleLabel(style) }),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        const nextStyles = customImageStyles.filter((item) => item.id !== style.id);
        customImageStylesRef.current = nextStyles;
        setCustomImageStyles(nextStyles);
        setSelectedImageStyleIds((current) => current.filter((id) => id !== style.id));
    }, [customImageStyles, setCustomImageStyles]);

    const handleHeaderModeSelect = React.useCallback((mode: NewSessionTopLevelMode) => {
        const nextAgent = selectAgentForTopLevelMode({
            mode,
            currentAgent: agentType,
            availableCodingAgents,
        });
        if (nextAgent !== agentType) {
            hapticsLight();
            setAgentType(nextAgent);
        }
    }, [agentType, availableCodingAgents, setAgentType]);

    React.useEffect(() => {
        if (activeImageAgent || isAskApiConfigured(askApi) || agentType !== 'ask') {
            return;
        }
        setAgentType(selectAgentForTopLevelMode({
            mode: 'agent',
            currentAgent: agentType,
            availableCodingAgents,
        }));
    }, [activeImageAgent, agentType, askApi, availableCodingAgents, setAgentType]);

    const handleTextChange = React.useCallback((nextText: string) => {
        setText(nextText);
    }, []);

    const clearQueuedSubmission = React.useCallback((snapshot: SubmittedComposeSnapshot) => {
        if (useComposeDraft.getState().revision === snapshot.textRevision) {
            composerInputRef.current?.setTextAndSelection('', { start: 0, end: 0 });
            setText('');
        }
        const currentAttachmentIds = new Set(selectedImagesRef.current.map((image) => image.id));
        for (const attachmentId of snapshot.userAttachmentIds) {
            if (currentAttachmentIds.has(attachmentId)) {
                removeImage(attachmentId);
            }
        }
    }, [removeImage]);

    const handleSend = React.useCallback(() => {
        const trimmed = text.trim();
        const userImages = hasImages ? selectedImages : [];
        const images = activeImageAgent
            ? [...selectedCustomReferenceImages, ...userImages]
            : userImages.length > 0 ? userImages : undefined;
        if ((!trimmed && !images) || sending || hydrationError) return;
        if (activeImageAgent && (!effectiveImageAgent || activeImageStyles.length === 0)) return;
        const prompt = activeImageAgent && effectiveImageAgent
            ? buildImageAgentPrompt({
                agent: effectiveImageAgent,
                customStyles: customImageStyles,
                userPrompt: trimmed,
                imageCount: images?.length ?? 0,
                styleReferenceImageCount: selectedCustomReferenceImages.length,
                userImageCount: userImages.length,
            })
            : trimmed;

        const draft = useNewSessionDraft.getState();
        const liveSelection = configPanelRef.current?.getSelection();
        const machine = machines.find((m) => m.id === draft.selectedMachineId);
        const spawnAgent = activeImageAgent ? 'codex' : draft.agentType;
        const resolvedModes = resolveNewSessionModeSelection({
            agent: spawnAgent,
            permissionMode: draft.permissionMode,
            modelMode: draft.modelMode,
            effortLevel: draft.effortLevel,
            agentDefaultOverrides,
        });
        const spawnSettings = resolveNewSessionSpawnSettings({
            draftWorktreeKey: draft.worktreeKey,
            resolvedModes,
            liveSelection,
        });

        // Spawnable only when a machine is selected, online, and we're not asked to
        // create a fresh worktree. The send button is disabled in every other case
        // (see `canSpawn` below), so this is just a safety guard.
        const canSpawn = !!draft.selectedMachineId
            && !!machine
            && isMachineOnline(machine)
            && spawnSettings.worktreeKey !== '__new__';
        if (!canSpawn) return;

        // Clear only after the encrypted first message reaches the local outbox.
        // A hydration failure keeps the draft available for the retry action.
        const submittedSnapshot: SubmittedComposeSnapshot = {
            text,
            textRevision: useComposeDraft.getState().revision,
            userAttachmentIds: userImages.map((image) => image.id),
        };
        pendingSubmissionRef.current = submittedSnapshot;
        spawn({
            machineId: draft.selectedMachineId!,
            machine: machine!,
            path: draft.selectedPath,
            agent: spawnAgent,
            ...spawnSettings,
            prompt,
            images,
            environmentVariables: spawnAgent === 'ask' ? buildAskApiEnvironment(askApi) : undefined,
            sidebarListId,
        }, false, () => {
            clearQueuedSubmission(submittedSnapshot);
            if (pendingSubmissionRef.current === submittedSnapshot) {
                pendingSubmissionRef.current = null;
            }
        });
    }, [activeImageAgent, effectiveImageAgent, activeImageStyles.length, agentDefaultOverrides, text, sending, hydrationError, machines, spawn, hasImages, selectedImages, askApi, customImageStyles, selectedCustomReferenceImages, sidebarListId, clearQueuedSubmission]);

    const handleRetryHydration = React.useCallback(async () => {
        await retryHydration();
    }, [retryHydration]);

    // The send target must be reachable: an online machine and no fresh-worktree
    // request. When it isn't, MessageComposer's send button greys out (via
    // isSendDisabled) instead of letting a doomed spawn through.
    const canSpawn = online && worktreeKey !== '__new__';
    const canSubmit = canSpawn && (!activeImageAgent || activeImageStyles.length > 0);
    const desktopRightPanelPresentation = getDesktopRightPanelPresentation({
        available: desktopRightPanelAvailable,
        collapsed: desktopRightPanelCollapsed,
        zenMode,
    });
    const showDesktopRightPanel = desktopRightPanelPresentation === 'expanded';
    const persistentHeaderContentInset = isTablet
        ? getPersistentHeaderContentInset({
            windowWidth,
            headerMaxWidth: layout.headerMaxWidth,
            headerHorizontalPadding: Platform.select({ ios: 8, default: 16 }) ?? 16,
            sidebarVisible: desktopLeftSidebarVisible,
            sidebarWidth: desktopLeftSidebarWidth,
            rightPanelWidth: showDesktopRightPanel ? desktopRightPanelWidth : 0,
            // SidebarNavigator 同时存在 `left: sidebar + 16` 和非 Tauri 环境下的
            // `paddingLeft: 16`，命中区域计算必须包含第二段偏移。
            controlStartPadding: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 16,
            buttonCount: Platform.OS === 'web' ? 4 : 3,
            controlsWidth: Platform.OS === 'web'
                ? PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH
                : getPersistentNavigationControlsWidth(3),
            targetHitSlop: 8,
        })
        : 0;

    const composerConfigControls = (
        <View style={styles.newSessionComposerControls} testID="new-session-composer-controls">
            {headerModeSwitchExperience.visible && (
                <View style={styles.headerModeSwitch}>
                    {HEADER_MODE_SWITCH_ITEMS.map((item) => {
                        const selected = item.key === headerModeSwitchExperience.selectedMode;
                        return (
                            <Pressable
                                key={item.key}
                                onPress={() => handleHeaderModeSelect(item.key)}
                                hitSlop={4}
                                accessibilityRole="button"
                                accessibilityLabel={item.key === 'ask' ? t('newSession.askMode') : t('newSession.agentMode')}
                                style={({ pressed }) => [
                                    styles.headerModeButton,
                                    selected && styles.headerModeButtonSelected,
                                    pressed && styles.headerModeButtonPressed,
                                ]}
                            >
                                <Ionicons
                                    name={item.icon}
                                    size={14}
                                    color={selected ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                                />
                            </Pressable>
                        );
                    })}
                </View>
            )}
            <SessionConfigPanel ref={configPanelRef} layout="composer" collapsible={false} />
        </View>
    );

    const capabilityHubLabel = t('rightPanelCapabilityHub.title');
    const rightPanelToggleButton = desktopRightPanelAvailable && desktopRightPanelPresentation !== 'zen' ? (
        <DesktopRightPanelToggleButton
            expanded={showDesktopRightPanel}
            label={showDesktopRightPanel
                ? t('desktopWorkspace.hidePanel', { panel: capabilityHubLabel })
                : t('desktopWorkspace.showPanel', { panel: capabilityHubLabel })}
            onPress={() => setDesktopRightPanelCollapsed(showDesktopRightPanel)}
        />
    ) : !isTablet ? (
        <CompactRightPanelToggleButton panelLabel={capabilityHubLabel} />
    ) : null;
    const composeContent = (
        <View style={styles.container}>
            <Header
                title={undefined}
                headerShadowVisible={false}
                headerTransparent={true}
                headerContentLeftInset={persistentHeaderContentInset}
                headerLeft={() => (
                    isScreen && !isTablet ? (
                        <Pressable
                            onPress={goBack}
                            hitSlop={12}
                            style={styles.headerButton}
                            testID="compose-home-back-button"
                        >
                            <Ionicons name="chevron-back" size={28} color={theme.colors.header.tint} />
                        </Pressable>
                    ) : !isScreen && !isTablet ? (
                        <Pressable
                            onPress={openDrawer}
                            hitSlop={12}
                            style={styles.headerButton}
                            testID="compose-home-drawer-button"
                        >
                            <Ionicons name="menu-outline" size={26} color={theme.colors.header.tint} />
                        </Pressable>
                    ) : null
                )}
                headerRight={isScreen && !rightPanelToggleButton ? undefined : () => (
                    <View style={styles.desktopHeaderActions}>
                        {rightPanelToggleButton}
                        {!isScreen && (
                            <Pressable
                                accessibilityLabel={t('settings.title')}
                                onPress={openSettings}
                                hitSlop={12}
                                style={styles.headerButton}
                                testID="compose-home-settings-button"
                            >
                                <Avatar
                                    id={profile.id}
                                    size={28}
                                    imageUrl={getAvatarUrl(profile)}
                                    thumbhash={profile.avatar?.thumbhash}
                                />
                            </Pressable>
                        )}
                    </View>
                )}
            />

            <KeyboardAvoidingView
                style={styles.body}
                behavior="padding"
            >
                <View style={styles.greetWrap}>
                    <ComposeHomeParticles mode={theme.dark ? 'dark' : 'light'} />
                    <View style={styles.greetingContent}>
                        <Text
                            style={[styles.greeting, isTablet && styles.greetingDesktop]}
                            testID="compose-home-greeting"
                        >
                            {displayAgent
                                ? t('composeHome.greetingAgent', { name: displayAgent.name })
                                : activeImageAgent
                                    ? t('composeHome.greetingAgent', { name: t('agents.imageStyleAgent') })
                                    : name
                                        ? t('composeHome.greeting', { name })
                                        : t('composeHome.greetingNoName')}
                        </Text>
                    </View>
                </View>

                <View style={[styles.composer, { paddingBottom: insets.bottom + 12 }]}>
                    {activeImageAgent && (
                        <View style={styles.imageAgentPanel} testID="compose-home-image-agent-panel">
                            <View style={styles.imageAgentHeader}>
                                <Ionicons
                                    name={sending ? 'lock-closed-outline' : 'sparkles-outline'}
                                    size={18}
                                    color={theme.colors.accent}
                                />
                                <View style={styles.imageAgentCopy}>
                                    <Text style={styles.imageAgentTitle} numberOfLines={1}>
                                        {sending ? t('agents.imageAgentLocked') : t('agents.imageAgentReady')}
                                    </Text>
                                    <Text style={styles.imageAgentSubtitle} numberOfLines={1}>
                                        {t('agents.imageAgentSummary', { count: activeImageStyles.length, variants: activeImageVariants })}
                                    </Text>
                                </View>
                            </View>
                            {hasImages && (
                                <Pressable
                                    onPress={createCustomImageStyle}
                                    style={({ pressed }) => [
                                        styles.imagePinStyleAction,
                                        pressed && styles.imagePinStyleActionPressed,
                                    ]}
                                    hitSlop={6}
                                >
                                    <View style={styles.imagePinStyleIcon}>
                                        <Ionicons name="sparkles-outline" size={18} color={theme.colors.button.primary.tint} />
                                    </View>
                                    <View style={styles.imagePinStyleCopy}>
                                        <Text style={styles.imagePinStyleTitle} numberOfLines={1}>
                                            {t('agents.customImageStyleCreateAction')}
                                        </Text>
                                        <Text style={styles.imagePinStyleSubtitle} numberOfLines={1}>
                                            {t('agents.customImageStyleDraftStatus', { count: selectedImages.length })}
                                        </Text>
                                    </View>
                                    <Ionicons name="chevron-forward" size={17} color={theme.colors.textSecondary} />
                                </Pressable>
                            )}
                            <Pressable
                                onPress={openImageStyleGallery}
                                testID="compose-home-image-effect-action"
                                style={({ pressed }) => [
                                    styles.imageEffectAction,
                                    pressed && styles.imageEffectActionPressed,
                                ]}
                                hitSlop={6}
                            >
                                <View style={styles.imageEffectIcon}>
                                    <Ionicons name="color-filter-outline" size={18} color={theme.colors.text} />
                                </View>
                                <View style={styles.imageEffectCopy}>
                                    <Text style={styles.imageEffectTitle} numberOfLines={1}>
                                        {imageEffectTitle}
                                    </Text>
                                    <Text style={styles.imageEffectSubtitle} numberOfLines={1}>
                                        {t('agents.imageEffectChooseHint')}
                                    </Text>
                                </View>
                                <Ionicons name="chevron-up" size={17} color={theme.colors.textSecondary} />
                            </Pressable>
                            <View style={styles.imageDrawControl}>
                                <View style={styles.imageDrawLabel}>
                                    <Ionicons name="dice-outline" size={16} color={theme.colors.textSecondary} />
                                    <Text style={styles.imageDrawLabelText} numberOfLines={1}>
                                        {t('agents.imageVariantsPerStyle', { count: activeImageVariants })}
                                    </Text>
                                </View>
                                <View style={styles.imageDrawOptions}>
                                    {Array.from({ length: MAX_IMAGE_AGENT_VARIANTS_PER_STYLE }, (_, index) => index + 1).map((count) => {
                                        const selected = activeImageVariants === count;
                                        return (
                                            <Pressable
                                                key={count}
                                                onPress={() => setImageDrawCount(count)}
                                                style={({ pressed }) => [
                                                    styles.imageDrawOption,
                                                    selected && styles.imageDrawOptionSelected,
                                                    pressed && styles.imageDrawOptionPressed,
                                                ]}
                                                hitSlop={4}
                                            >
                                                <Text
                                                    style={[
                                                        styles.imageDrawOptionText,
                                                        selected && styles.imageDrawOptionTextSelected,
                                                    ]}
                                                >
                                                    {count}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                            </View>
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={styles.imageStyleRow}
                                keyboardShouldPersistTaps="always"
                            >
                                {activeImageStyles.map((style) => (
                                    <Pressable
                                        key={style.id}
                                        onPress={openImageStyleGallery}
                                        style={({ pressed }) => [
                                            styles.imageStyleChip,
                                            pressed && styles.imageStyleChipPressed,
                                        ]}
                                        hitSlop={6}
                                    >
                                        <Text style={styles.imageStyleChipText} numberOfLines={1}>
                                            {getImageAgentStyleLabel(style)}
                                        </Text>
                                    </Pressable>
                                ))}
                            </ScrollView>
                        </View>
                    )}
                    {composeExperience.showCreationRail && (
                        <View
                            style={[
                                styles.creationRail,
                                windowWidth <= 700 && styles.creationRailCompact,
                            ]}
                            testID="compose-home-creation-rail"
                        >
                            <Pressable
                                onPress={openImageStyleMode}
                                style={({ pressed }) => [
                                    styles.creationAction,
                                    pressed && styles.creationActionPressed,
                                ]}
                                hitSlop={6}
                            >
                                <View style={styles.creationActionIcon}>
                                    <Ionicons name="sparkles-outline" size={17} color={theme.colors.text} />
                                </View>
                                <View style={styles.creationActionCopy}>
                                    <Text style={styles.creationActionTitle} numberOfLines={1}>
                                        {t('agents.imageCreationAction')}
                                    </Text>
                                    <Text style={styles.creationActionSubtitle} numberOfLines={1}>
                                        {t('agents.imageCreationActionSubtitle')}
                                    </Text>
                                </View>
                            </Pressable>
                        </View>
                    )}
                    {displayAgent && displayAgent.presets.length > 0 && (
                        <View style={styles.presetRow}>
                            {displayAgent.presets.map((preset, i) => (
                                <Pressable
                                    key={`${preset.label}-${i}`}
                                    onPress={() => fillPreset(preset.prompt)}
                                    style={styles.presetChip}
                                    hitSlop={6}
                                >
                                    <Text style={styles.presetChipText} numberOfLines={1}>{preset.label}</Text>
                                </Pressable>
                            ))}
                        </View>
                    )}
                    {hydrationError && (
                        <View
                            style={styles.sessionHydrationError}
                            testID="compose-home-session-hydration-error"
                        >
                            <Text style={styles.sessionHydrationErrorText}>
                                {t('newSession.sessionHydrationFailed')}
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                onPress={handleRetryHydration}
                                disabled={sending}
                                style={({ pressed }) => [
                                    styles.sessionHydrationRetry,
                                    pressed && styles.sessionHydrationRetryPressed,
                                ]}
                                testID="compose-home-session-hydration-retry"
                            >
                                <Text style={styles.sessionHydrationRetryText}>{t('common.retry')}</Text>
                            </Pressable>
                        </View>
                    )}
                    <MessageComposer
                        ref={composerInputRef}
                        mode="home"
                        placeholder={activeImageAgent
                            ? t('agents.imagePromptPlaceholder')
                            : agentType === 'ask'
                                ? t('composeHome.askPlaceholder')
                                : t('composeHome.placeholder')}
                        initialValue={text}
                        onChangeText={handleTextChange}
                        onSend={handleSend}
                        isSending={sending}
                        isSendDisabled={!canSubmit || Boolean(hydrationError)}
                        selectedImages={hasImages ? selectedImages : undefined}
                        selectedImagesPresentation={activeImageAgent ? 'featured' : 'compact'}
                        // Image agent needs images only; the normal composer
                        // offers the photo/audio-video chooser.
                        onPickImages={canAttach ? (activeImageAgent ? pickImages : pickAttachment) : undefined}
                        onRemoveImage={canAttach ? removeImage : undefined}
                        onAddImages={canAttach ? addImages : undefined}
                        leadingControls={composerConfigControls}
                    />
                    <Text style={styles.byline}>{t('composeHome.byline')}</Text>
                </View>
            </KeyboardAvoidingView>

            {activeImageAgent && (
                <ImageStyleGallerySheet
                    visible={imageGalleryOpen}
                    styles={galleryImageStyles}
                    selectedStyleIds={selectedImageStyleIds}
                    canCreateCustomStyle={hasImages}
                    onCreateCustomStyle={createCustomImageStyle}
                    onDeleteCustomStyle={deleteCustomImageStyle}
                    onRetryCustomStyleAnalysis={retryCustomImageStyleAnalysis}
                    onPickImages={pickImages}
                    onToggle={toggleImageStyleFromGallery}
                    onClose={closeImageStyleGallery}
                />
            )}
        </View>
    );

    if (!desktopRightPanelAvailable) {
        return (
            <RightSwipePanelHost
                closeAccessibilityLabel={t('desktopWorkspace.hidePanel', { panel: capabilityHubLabel })}
                gestureEnabled={false}
                openAccessibilityLabel={t('desktopWorkspace.showPanel', { panel: capabilityHubLabel })}
                panelAccessibilityLabel={capabilityHubLabel}
                panelContent={<SessionCapabilityHub />}
            >
                {composeContent}
            </RightSwipePanelHost>
        );
    }

    return (
        <View style={styles.desktopWorkspace}>
            <View style={styles.desktopWorkspaceMain} testID="desktop-workspace-main">
                {composeContent}
            </View>
            <View
                {...(Platform.OS === 'web' ? { inert: showDesktopRightPanel ? undefined : true } as any : {})}
                aria-hidden={!showDesktopRightPanel}
                accessibilityElementsHidden={!showDesktopRightPanel}
                importantForAccessibility={showDesktopRightPanel ? 'auto' : 'no-hide-descendants'}
                pointerEvents={showDesktopRightPanel ? 'auto' : 'none'}
                style={[
                    styles.desktopWorkspacePanelClip,
                    { width: showDesktopRightPanel ? desktopRightPanelWidth : 0 },
                ]}
            >
                <View
                    {...(Platform.OS === 'web' ? {
                        dataSet: {
                            happyMotion: 'desktop-panel',
                            happyMotionSide: 'right',
                            happyMotionState: showDesktopRightPanel ? 'open' : 'closed',
                        },
                    } as any : {})}
                    style={[
                        styles.desktopWorkspacePanel,
                        { width: desktopRightPanelExpandedWidth },
                        Platform.OS === 'web' && styles.desktopWorkspacePanelWeb,
                    ]}
                    testID="desktop-right-panel-motion"
                >
                    <DesktopRightPanel
                        activeTab="capabilities"
                        collapseAccessibilityLabel={t('desktopWorkspace.hidePanel', {
                            panel: t('rightPanelCapabilityHub.title'),
                        })}
                        collapseLabel={t('desktopWorkspace.hidePanelShort')}
                        onCollapse={() => setDesktopRightPanelCollapsed(true)}
                        onTabChange={() => undefined}
                        showCollapseButton={false}
                        tabs={[{
                            key: 'capabilities',
                            label: t('rightPanelCapabilityHub.title'),
                            icon: 'sparkles-outline',
                        }]}
                    >
                        <SessionCapabilityHub />
                    </DesktopRightPanel>
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    desktopWorkspace: {
        flex: 1,
        flexDirection: 'row',
    },
    desktopWorkspaceMain: {
        flex: 1,
        minWidth: DESKTOP_MAIN_MIN_WIDTH,
    },
    desktopWorkspacePanel: {
        flex: 1,
        flexShrink: 0,
    },
    desktopWorkspacePanelClip: {
        minWidth: 0,
        alignSelf: 'stretch',
        overflow: Platform.OS === 'web' ? 'visible' : 'hidden',
    },
    desktopWorkspacePanelWeb: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
    },
    desktopHeaderActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    headerButton: {
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    newSessionComposerControls: {
        minWidth: 0,
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        overflow: 'hidden',
    },
    headerModeSwitch: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 999,
        backgroundColor: theme.colors.input.background,
    },
    headerModeButton: {
        width: 26,
        height: 24,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerModeButtonSelected: {
        backgroundColor: theme.colors.button.primary.background,
    },
    headerModeButtonPressed: {
        opacity: 0.78,
    },
    body: {
        flex: 1,
    },
    greetWrap: {
        flex: 1,
        justifyContent: 'flex-start',
        paddingHorizontal: 26,
        paddingTop: 28,
    },
    greetingContent: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    greeting: {
        ...Typography.display('semiBold'),
        fontSize: 26,
        lineHeight: 34,
        color: theme.colors.text,
        maxWidth: 360,
    },
    greetingDesktop: {
        maxWidth: 520,
    },
    composer: {
        paddingHorizontal: 14,
        paddingTop: 8,
    },
    sessionHydrationError: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginBottom: 10,
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.status.error,
    },
    sessionHydrationErrorText: {
        ...Typography.default(),
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textDestructive,
    },
    sessionHydrationRetry: {
        minHeight: 32,
        justifyContent: 'center',
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: theme.colors.surfacePressed,
    },
    sessionHydrationRetryPressed: {
        opacity: 0.72,
    },
    sessionHydrationRetryText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text,
    },
    imageAgentPanel: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        padding: 10,
        gap: 8,
        marginBottom: 10,
    },
    imageAgentHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    imageAgentCopy: {
        flex: 1,
    },
    imageAgentTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    imageAgentSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 1,
    },
    imageUploadAction: {
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 9,
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: theme.colors.surfacePressed,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    imageUploadActionPressed: {
        opacity: 0.78,
    },
    imageUploadIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
    },
    imageUploadCopy: {
        flex: 1,
    },
    imageUploadTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    imageUploadSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    imageReferenceActions: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: 8,
    },
    imageAddReferenceAction: {
        minHeight: 52,
        minWidth: 88,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        paddingHorizontal: 8,
        borderRadius: 12,
        backgroundColor: theme.colors.surfacePressed,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    imageAddReferenceActionPressed: {
        opacity: 0.78,
    },
    imageAddReferenceText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.text,
    },
    imagePinStyleAction: {
        flex: 1,
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: theme.colors.button.primary.background,
    },
    imagePinStyleActionPressed: {
        opacity: 0.82,
    },
    imagePinStyleIcon: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.18)',
    },
    imagePinStyleCopy: {
        flex: 1,
    },
    imagePinStyleTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.button.primary.tint,
    },
    imagePinStyleSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.button.primary.tint,
        opacity: 0.78,
        marginTop: 1,
    },
    imageEffectAction: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: theme.colors.surfacePressed,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    imageEffectActionPressed: {
        opacity: 0.78,
    },
    imageEffectIcon: {
        width: 32,
        height: 32,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
    },
    imageEffectCopy: {
        flex: 1,
    },
    imageEffectTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    imageEffectSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 1,
    },
    imageDrawControl: {
        minHeight: 38,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: 12,
        backgroundColor: theme.colors.surfacePressed,
    },
    imageDrawLabel: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    imageDrawLabelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    imageDrawOptions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    imageDrawOption: {
        width: 30,
        height: 26,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    imageDrawOptionSelected: {
        backgroundColor: theme.colors.text,
        borderColor: theme.colors.text,
    },
    imageDrawOptionPressed: {
        opacity: 0.72,
    },
    imageDrawOptionText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    imageDrawOptionTextSelected: {
        color: theme.colors.surface,
    },
    imageStyleRow: {
        gap: 6,
        paddingRight: 8,
    },
    imageStyleChip: {
        maxWidth: 180,
        height: 28,
        paddingHorizontal: 10,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfacePressed,
    },
    imageStyleChipPressed: {
        opacity: 0.75,
    },
    imageStyleChipText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text,
    },
    creationRail: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        flexDirection: 'row',
        paddingBottom: 10,
    },
    creationRailCompact: {
        paddingHorizontal: 8,
    },
    creationAction: {
        minHeight: 46,
        maxWidth: 220,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        paddingVertical: 8,
        paddingLeft: 9,
        paddingRight: 14,
        borderRadius: 23,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    creationActionPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    creationActionIcon: {
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfacePressed,
    },
    creationActionCopy: {
        flexShrink: 1,
    },
    creationActionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    creationActionSubtitle: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 1,
    },
    presetRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: 4,
        paddingBottom: 10,
    },
    presetChip: {
        maxWidth: 240,
        paddingVertical: 7,
        paddingHorizontal: 13,
        borderRadius: 999,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    presetChipText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
    },
    byline: {
        ...Typography.default(),
        textAlign: 'center',
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 9,
    },
}));
