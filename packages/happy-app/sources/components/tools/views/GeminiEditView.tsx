import * as React from 'react';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';

/**
 * Extract edit content from Gemini's nested input format.
 * 
 * Gemini sends data in nested structure:
 * - tool.input.toolCall.content[0] 
 * - tool.input.input[0]
 * - tool.input (direct fields)
 */
function extractEditContent(input: any): { oldText: string; newText: string; path: string } {
    // Try various locations where Gemini might put the edit data
    
    // 1. Check tool.input.toolCall.content[0]
    if (input?.toolCall?.content?.[0]) {
        const content = input.toolCall.content[0];
        return {
            oldText: content.oldText || '',
            newText: content.newText || '',
            path: content.path || ''
        };
    }
    
    // 2. Check tool.input.input[0] (array format)
    if (Array.isArray(input?.input) && input.input[0]) {
        const content = input.input[0];
        return {
            oldText: content.oldText || '',
            newText: content.newText || '',
            path: content.path || ''
        };
    }
    
    // 3. Check direct fields (simple format)
    return {
        oldText: input?.oldText || input?.old_string || '',
        newText: input?.newText || input?.new_string || '',
        path: input?.path || input?.file_path || ''
    };
}

/**
 * Gemini Edit View
 * 
 * Handles Gemini's edit tool format which uses:
 * - oldText (instead of old_string)
 * - newText (instead of new_string)
 * - path (instead of file_path)
 */
export const GeminiEditView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    
    const { oldText, newText } = extractEditContent(tool.input);
    const oldString = trimIdent(oldText);
    const newString = trimIdent(newText);

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView 
                    oldText={oldString} 
                    newText={newString} 
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                />
            </ToolSectionView>
        </>
    );
});

