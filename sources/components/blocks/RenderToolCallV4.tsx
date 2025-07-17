import React from 'react';
import { View, Text } from 'react-native';
import { type ToolCall } from '@/sync/storageTypes';

import { BashCompactView, type BashToolCall } from './ToolCalls/Bash';
import { EditCompactView, type EditToolCall } from './ToolCalls/Edit';
import { ReadCompactView, type ReadToolCall } from './ToolCalls/Read';
import { GrepCompactView, type GrepToolCall } from './ToolCalls/Grep';
import { TodoWriteCompactView, type TodoWriteToolCall } from './ToolCalls/TodoWrite';

// Component that dispatches to different tool renderers based on tool type
export function RenderToolV4({ tool, sessionId, messageId }: { tool: ToolCall, sessionId: string, messageId: string }) {
  switch (tool.name) {
    case 'Bash':
      return <BashCompactView tool={tool as BashToolCall} sessionId={sessionId} messageId={messageId} />;
    
    case 'Edit':
      return <EditCompactView tool={tool as EditToolCall} sessionId={sessionId} messageId={messageId} />;
      
    case "Read":
      return <ReadCompactView tool={tool as ReadToolCall}/>;
      
    case "Grep":
      return <GrepCompactView tool={tool as GrepToolCall} sessionId={sessionId} messageId={messageId}/>;
    
    case "TodoWrite":
      return <TodoWriteCompactView tool={tool as TodoWriteToolCall} />;
    
    case "Task":
      return null;
    
    // case "LS":
    //   return <LsCompactView tool={tool as LsToolCall} sessionId={sessionId} messageId={messageId}/>;
    
    default:
      // Fallback for unknown tool types
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2 }}>
          <Text style={{ fontSize: 16, color: '#6b7280', fontStyle: 'italic' }}>
            {tool.name}
          </Text>
        </View>
      );
  }
} 