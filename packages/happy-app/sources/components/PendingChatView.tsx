import * as React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentContentView } from './AgentContentView';
import { AgentInput } from './AgentInput';
import { ShimmerText } from './ShimmerText';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import { useComposerModes } from '@/hooks/useComposerModes';
import {
    dismissPendingChat,
    requestComposerFocus,
    setPendingChatDraft,
    submitPendingChat,
    type PendingChat,
} from '@/sync/pendingChats';
import { returnPendingChatDraft } from '@/sync/pendingChatHandover';
import { claimComposerFocus } from '@/utils/composerFocus';
import type { MultiTextInputHandle } from './MultiTextInput';
import { useSession } from '@/sync/storage';
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { useDeviceType, useIsLandscape } from '@/utils/responsive';

// Nothing is fetched for a chat that does not exist, so the autocomplete has
// nothing to offer either.
const NO_AUTOCOMPLETE_PREFIXES: string[] = [];
const noSuggestions = async () => [];

/**
 * The chat you get the instant you ask for one, before any machine has agreed
 * to run it.
 *
 * Starting a session is a round trip that can take seconds, and the old flow
 * spent them on a spinner in the strip's `+` with the user still on the chat
 * they pressed it from. This is the destination, arrived at immediately: the
 * right header, the right tab, the composer already in its place.
 *
 * The composer is live and focused from the first frame. A chat is asked for in
 * order to be typed into, and the seconds the machine spends answering are
 * exactly the seconds the user would otherwise spend composing — so they are
 * given back. What is typed here is the real chat's the moment it exists:
 * `handOverPendingChat` writes it on as a draft, or sends it, if send was
 * already pressed.
 *
 * The cost is one handover of the caret, from this composer to the real one,
 * which the arriving screen claims back through `requestComposerFocus`.
 */
export const PendingChatView = React.memo(({ pending }: { pending: PendingChat }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const deviceType = useDeviceType();
    const isLandscape = useIsLandscape();
    // The chat this one was started beside decides how it will be configured,
    // so it is also what the composer can honestly show in the meantime.
    const anchor = useSession(pending.anchorSessionId);
    const modes = useComposerModes(anchor);

    const usesFloatingMobileDock = deviceType === 'phone'
        && Platform.OS !== 'web'
        && !isRunningOnMac()
        && !isLandscape;

    /** Handing over is a one-way door, and the effects below both go through it. */
    const handedOver = React.useRef(false);

    const inputRef = React.useRef<MultiTextInputHandle>(null);
    // Read once, like every other composer here: the textarea is uncontrolled,
    // and re-seeding it from the store on a later render would fight the caret.
    const initialDraft = React.useRef(pending.draft).current;

    // The chat was asked for so it could be typed into, so the caret starts
    // here — on the press, not a beat after it.
    React.useLayoutEffect(() => claimComposerFocus(inputRef), []);

    const handleChangeText = React.useCallback((text: string) => {
        // The store is read by the handover, not by this render, so it can go
        // at whatever priority React has to spare.
        React.startTransition(() => setPendingChatDraft(pending.id, text));
    }, [pending.id]);

    /**
     * Send, on a chat with nothing to send to yet. The text is handed to the
     * record and the field is emptied, which is what pressing send does
     * everywhere else; it leaves for the machine as the chat's first message
     * the moment there is a chat.
     */
    const handleSend = React.useCallback(() => {
        const text = inputRef.current?.getText() ?? '';
        if (!text.trim()) return;
        submitPendingChat(pending.id, text);
        inputRef.current?.setTextAndSelection('', { start: 0, end: 0 });
    }, [pending.id]);

    // The machine named the chat. `startSession` syncs the session list before
    // it says so, so the route can be pointed straight at it.
    const sessionId = pending.sessionId;
    React.useEffect(() => {
        if (!sessionId || handedOver.current) return;
        handedOver.current = true;
        requestComposerFocus(sessionId);
        router.setParams({ id: sessionId });
    }, [sessionId, router]);

    // The start failed and has already said why, in its own words. All that is
    // left is to stop standing on a tab that is not coming.
    React.useEffect(() => {
        if (pending.status !== 'failed' || handedOver.current) return;
        handedOver.current = true;
        // The chat is not coming; the typing should not go down with it.
        returnPendingChatDraft(pending.id);
        router.setParams({ id: pending.anchorSessionId });
    }, [pending.status, pending.anchorSessionId, pending.id, router]);

    /**
     * A stand-in that has handed over is spent, and this unmount is the handover
     * taking effect. Kept any longer it is a record of a chat that has a real
     * one, which nothing should ever be asked to draw or open again.
     *
     * Gated on the handover rather than run unconditionally: leaving the screen
     * mid-start is not the end of the start, and a cleanup that runs on setup —
     * which Strict Mode does in development — must not retire a chat that is
     * still on its way.
     */
    React.useEffect(() => () => {
        if (handedOver.current) dismissPendingChat(pending.id);
    }, [pending.id]);

    const placeholder = (
        <View style={styles.placeholder}>
            <Ionicons
                name="chatbubbles-outline"
                size={64}
                color={theme.colors.textSecondary}
                style={styles.placeholderIcon}
            />
            <ShimmerText
                text={t('session.startingChat')}
                style={styles.placeholderTitle}
                baseColor={theme.colors.textSecondary}
                highlightColor={theme.colors.text}
            />
            {/* Messages sent before the chat existed have left the composer but
                have not reached anything yet. They are shown here so the send
                is not a keystroke that went nowhere. */}
            {pending.queued.length > 0 ? (
                <Text style={styles.placeholderQueued} numberOfLines={6}>
                    {pending.queued.join('\n\n')}
                </Text>
            ) : anchor?.metadata?.path ? (
                <Text style={styles.placeholderPath} numberOfLines={1}>
                    {formatPathRelativeToHome(anchor.metadata.path, anchor.metadata.homeDir)}
                </Text>
            ) : null}
        </View>
    );

    // The composer the real chat will mount, minus what needs a chat to answer
    // it: the chips report what this one is about to start as, and completion
    // has nothing to complete against yet.
    const input = (
        <AgentInput
            ref={inputRef}
            initialValue={initialDraft}
            placeholder={t('session.inputPlaceholder')}
            onChangeText={handleChangeText}
            onSend={handleSend}
            permissionMode={modes.permissionMode}
            availableModes={modes.availableModes}
            modelMode={modes.modelMode}
            availableModels={modes.availableModels}
            effortLevel={modes.effortLevel}
            availableEffortLevels={modes.availableEffortLevels}
            metadata={anchor?.metadata ?? null}
            autocompletePrefixes={NO_AUTOCOMPLETE_PREFIXES}
            autocompleteSuggestions={noSuggestions}
        />
    );

    return (
        <View style={{
            flexBasis: 0,
            flexGrow: 1,
            paddingBottom: usesFloatingMobileDock
                ? 0
                : safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 8 : 0),
        }}>
            <AgentContentView
                placeholder={placeholder}
                input={input}
                floatingDock={usesFloatingMobileDock}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    placeholder: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 48,
    },
    placeholderIcon: {
        marginBottom: 16,
    },
    placeholderTitle: {
        fontSize: 18,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    placeholderQueued: {
        marginTop: 10,
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.text,
        textAlign: 'center',
        ...Typography.default(),
    },
    placeholderPath: {
        marginTop: 6,
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
