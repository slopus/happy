import * as React from 'react';
import { ScrollView } from 'react-native';
import { DiffView } from '@/components/diff/DiffView';

interface ToolDiffViewProps {
    oldText: string;
    newText: string;
    style?: any;
    showLineNumbers?: boolean;
    showPlusMinusSymbols?: boolean;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({ 
    oldText, 
    newText, 
    style, 
    showLineNumbers = false,
    showPlusMinusSymbols = false 
}) => {
    return (
        <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={true}
            contentContainerStyle={{ flexGrow: 1 }}
        >
            <DiffView 
                oldText={oldText} 
                newText={newText} 
                wrapLines={false}
                showLineNumbers={showLineNumbers}
                showPlusMinusSymbols={showPlusMinusSymbols}
                style={{ flex: 1, ...style }}
            />
        </ScrollView>
    );
});