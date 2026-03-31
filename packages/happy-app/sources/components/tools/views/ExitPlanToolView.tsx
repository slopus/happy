import * as React from 'react';
import { ToolViewProps } from "./_all";
import { ToolSectionView } from '../../tools/ToolSectionView';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { PermissionFooter } from '../../tools/PermissionFooter';
import { knownTools } from '../../tools/knownTools';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';

export const ExitPlanToolView = React.memo<ToolViewProps>(({ tool, sessionId, metadata }) => {
    let plan = '<empty>'
    const parsed = knownTools.ExitPlanMode.input.safeParse(tool.input);
    if (parsed.success) {
        plan = parsed.data.plan ?? '<empty>';
    }
    return (
        <>
            <ToolSectionView>
                <View style={styles.planContainer}>
                    <Text style={styles.planLabel}>{t('tools.names.proposedPlan')}</Text>
                    <MarkdownView markdown={plan} sessionId={sessionId} />
                </View>
            </ToolSectionView>
            {tool.permission && sessionId && (
                <PermissionFooter
                    permission={tool.permission}
                    sessionId={sessionId}
                    toolName={tool.name}
                    toolInput={tool.input}
                    metadata={metadata}
                />
            )}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    planContainer: {
        paddingHorizontal: 8,
    },
    planLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginBottom: 4,
    },
}));
