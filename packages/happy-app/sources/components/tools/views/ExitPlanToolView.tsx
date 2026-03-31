import * as React from 'react';
import { ToolViewProps } from "./_all";
import { ToolSectionView } from '../../tools/ToolSectionView';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { PermissionFooter } from '../../tools/PermissionFooter';
import { knownTools } from '../../tools/knownTools';
import { View } from 'react-native';

export const ExitPlanToolView = React.memo<ToolViewProps>(({ tool, sessionId, metadata }) => {
    let plan = '<empty>'
    const parsed = knownTools.ExitPlanMode.input.safeParse(tool.input);
    if (parsed.success) {
        plan = parsed.data.plan ?? '<empty>';
    }
    return (
        <>
            <ToolSectionView>
                <View style={{ paddingHorizontal: 8, marginTop: -10 }}>
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
