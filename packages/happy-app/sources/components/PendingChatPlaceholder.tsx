import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ShimmerText } from './ShimmerText';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import type { PendingChat } from '@/sync/pendingChats';
import { useSession } from '@/sync/storage';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';

/**
 * What a chat shows while no machine has agreed to run it yet.
 *
 * Starting a session is a round trip to a computer that can take seconds, and
 * the old flow spent them on a spinner in the strip's `+` with the user still
 * on the chat they pressed it from. This is the destination, arrived at
 * immediately: the right header, the right tab, and — above all — the composer
 * already in its place, live and focused, because the seconds the machine
 * spends answering are exactly the seconds the user would spend composing.
 *
 * Only the message area is drawn here. The composer belongs to the screen and
 * is the same one throughout: it was never a placeholder.
 */
export const PendingChatPlaceholder = React.memo(({ pending }: { pending: PendingChat }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    // The chat this one was started beside, which is where it will run.
    const anchor = useSession(pending.anchorSessionId);

    return (
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
