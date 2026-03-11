import * as React from 'react';
import { Text, View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { LongPressCopy, useCopySelectable } from './LongPressCopy';

interface CodeViewProps {
    code: string;
    language?: string;
}

export const CodeView = React.memo<CodeViewProps>(({
    code,
    language
}) => {
    const selectable = useCopySelectable();

    return (
        <LongPressCopy text={code}>
            <View style={styles.codeBlock}>
                <Text selectable={selectable} style={styles.codeText}>{code}</Text>
            </View>
        </LongPressCopy>
    );
});

const styles = StyleSheet.create((theme) => ({
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
        padding: 12,
    },
    codeText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
        fontSize: 12,
        color: theme.colors.text,
        lineHeight: 18,
    },
}));
