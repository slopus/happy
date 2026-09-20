import * as React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type TerminalLine =
    | { kind: 'command'; text: string }
    | { kind: 'comment'; text: string };

// The palette is the terminal on happy.engineering, so the block a person
// sees on their phone is the one they saw on the download page. It is dark
// in both colour schemes: a terminal is a terminal.
const TERMINAL_BACKGROUND = '#14352f';
const TERMINAL_BORDER = '#24463f';
const TERMINAL_TEXT = '#f0ebe0';
const TERMINAL_PROMPT = '#6fae74';
const TERMINAL_COMMENT = '#8fae8a';

/**
 * A few shell lines the way the website draws them: green `$` prompt, muted
 * comments, commands selectable so they can be copied.
 */
export const TerminalBlock = React.memo(function TerminalBlock({
    lines,
    style,
}: {
    lines: readonly TerminalLine[];
    style?: StyleProp<ViewStyle>;
}) {
    return (
        <View style={[styles.block, style]}>
            {lines.map((line, index) => (
                line.kind === 'comment' ? (
                    <Text key={index} style={[styles.line, styles.comment]} selectable>
                        {line.text}
                    </Text>
                ) : (
                    <Text key={index} style={styles.line} selectable>
                        <Text style={styles.prompt} selectable={false}>$ </Text>
                        {line.text}
                    </Text>
                )
            ))}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    block: {
        alignSelf: 'stretch',
        backgroundColor: TERMINAL_BACKGROUND,
        borderColor: TERMINAL_BORDER,
        borderWidth: 1,
        borderRadius: 14,
        paddingVertical: 14,
        paddingHorizontal: 18,
    },
    line: {
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 24,
        color: TERMINAL_TEXT,
    },
    prompt: {
        ...Typography.mono(),
        color: TERMINAL_PROMPT,
    },
    comment: {
        color: TERMINAL_COMMENT,
    },
}));
