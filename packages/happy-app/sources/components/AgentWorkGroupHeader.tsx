import * as React from 'react';
import { Text, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { AgentWorkGroupItem, formatWorkDuration } from '@/hooks/useGroupedMessages';
import { layout } from './layout';
import { t } from '@/text';

/**
 * The one-line toggle for a completed turn's intermediate work. It is only a
 * toggle: the group's messages are separate list items inserted next to it
 * while expanded, so tapping it changes the list data and the content unfolds
 * — this row itself never grows.
 *
 * An expanded group renders two of these, one at each end of its content. The
 * reason is geometric, and load-bearing enough that changing the height of
 * this row will break it: the chat list is inverted, so its fixed point is the
 * bottom-most visible row. Content inserted into a group therefore grows
 * upward, carrying the tapped header off the top of the screen. The trailing
 * copy takes the header's place at the bottom edge of the expansion — the same
 * pixels the reader just tapped, because both rows are this same component and
 * so exactly as tall. Collapsing from it returns the viewport to where it
 * started.
 */
export const AgentWorkGroupHeader = React.memo((props: {
    group: AgentWorkGroupItem;
    expanded: boolean;
    onToggle: () => void;
    /**
     * 'leading' is the summary above the group. 'trailing' is the collapse
     * control below it, rendered only while expanded.
     */
    placement?: 'leading' | 'trailing';
}) => {
    const { theme } = useUnistyles();
    const durationMs = (props.group.completedAt ?? props.group.startedAt) - props.group.startedAt;
    const trailing = props.placement === 'trailing';
    const label = trailing
        ? t('toolGroup.hide')
        : t('toolGroup.workedFor', { duration: formatWorkDuration(durationMs) });

    return (
        <View style={styles.outerContainer}>
            <View style={styles.innerContainer}>
                <Pressable
                    onPress={props.onToggle}
                    style={({ pressed }) => [
                        styles.header,
                        pressed && styles.headerPressed,
                    ]}
                >
                    <Text style={styles.summaryText} numberOfLines={1}>
                        {label}
                    </Text>
                    <Ionicons
                        name={trailing || props.expanded ? 'chevron-up' : 'chevron-forward'}
                        size={13}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    innerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        maxWidth: layout.maxWidth,
        marginVertical: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'stretch',
        marginHorizontal: 16,
        minHeight: 28,
        paddingVertical: 4,
        borderRadius: 4,
    },
    headerPressed: {
        opacity: 0.6,
    },
    summaryText: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
}));
