import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { CommandView } from '@/components/CommandView';
import { getTerminalToolCommand, getToolActivityLabel } from '@/utils/toolDisplay';
import { getShellControl } from '@/utils/happyToolDisplay';
import { getTerminalToolResult } from '@/utils/toolResult';
import { CodeView } from '@/components/CodeView';
import { ToolSectionView } from '../ToolSectionView';
import { t } from '@/text';

interface BashViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const BashViewFull = React.memo<BashViewFullProps>(({ tool }) => {
    const command = getTerminalToolCommand(tool);
    const control = getShellControl(tool);
    const result = getTerminalToolResult(tool);

    return (
        <View style={styles.container}>
            <CommandView
                command={command ?? getToolActivityLabel(tool)}
                prompt={command ? '$' : ''}
                {...result}
                error={tool.state === 'error' ? result.error || t('tools.fullView.error') : null}
                hideEmptyOutput={tool.state === 'running'}
                syntaxHighlighting
                commandLanguage={command ? 'bash' : null}
                fullWidth
            />
            {control?.chars !== undefined && (
                <ToolSectionView title={t('toolView.input')}>
                    <CodeView code={control.chars} />
                </ToolSectionView>
            )}
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        width: '100%',
        gap: 16,
    },
});