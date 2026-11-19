/**
 * Native fallback for CodeEditor — should never be rendered on native.
 * The file edit feature is web-only. This stub prevents import errors.
 */
import * as React from 'react';
import type { FileLocation } from '@/utils/fileLocation';
import { View, Text } from 'react-native';

interface CodeEditorProps {
    value: string;
    onChange: (value: string) => void;
    language: string | null;
    darkMode: boolean;
    readOnly?: boolean;
    location?: FileLocation;
    onRevealLine?: (offset: number) => void;
}

export const CodeEditor = React.memo(function CodeEditor(_props: CodeEditorProps) {
    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Text>Editor not available on this platform</Text>
        </View>
    );
});
