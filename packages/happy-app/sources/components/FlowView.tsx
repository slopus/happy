import { CodeView } from '@/components/CodeView';
import { ToolSectionView } from '@/components/tools/ToolSectionView';
import type { FlowRunState } from '@slopus/happy-sync';
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object';
}

export const FlowView = React.memo((props: { flow: FlowRunState | null | undefined }) => {
    if (!props.flow || !isRecord(props.flow)) {
        return null;
    }

    return (
        <View style={styles.container}>
            <Text style={styles.title}>Flow</Text>
            <ToolSectionView title="State">
                <CodeView code={JSON.stringify(props.flow, null, 2)} />
            </ToolSectionView>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    title: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '600',
        marginBottom: 4,
    },
}));
