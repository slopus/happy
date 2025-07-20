import React from 'react';
import { View, Text } from 'react-native';
import { type ToolCall } from '@/sync/storageTypes';

import { BashCompactView, BashDetailedView, type BashToolCall } from './ToolCalls/Bash';
import { EditCompactView, EditDetailedView, type EditToolCall } from './ToolCalls/Edit';
import { ReadCompactView, type ReadToolCall } from './ToolCalls/Read';
import { GrepCompactView, type GrepToolCall } from './ToolCalls/Grep';
import { TodoWriteCompactView, TodoWriteDetailedView, type TodoWriteToolCall } from './ToolCalls/TodoWrite';
import { LSCompactView, LSDetailedView, type LSToolCall } from './ToolCalls/LS';
import { WriteCompactView, WriteDetailedView, WriteToolCall } from './ToolCalls/Write';
import { MCPCompactView, MCPToolCall } from './ToolCalls/MCP';
import { UnknownToolDetailedView } from './ToolCalls/Unknown';

// Component that dispatches to different tool renderers based on tool type
export function CompactToolBlock({ tool, sessionId, messageId }: { tool: ToolCall, sessionId: string, messageId: string }) {
  switch (tool.name) {
    case 'Bash':
      return <BashCompactView tool={tool as BashToolCall} sessionId={sessionId} messageId={messageId} />;
    
    case 'Edit':
      return <EditCompactView tool={tool as EditToolCall} sessionId={sessionId} messageId={messageId} />;
      
    case "Read":
      return <ReadCompactView tool={tool as ReadToolCall} sessionId={sessionId} messageId={messageId}/>;
      
    case "Grep":
      return <GrepCompactView tool={tool as GrepToolCall} sessionId={sessionId} messageId={messageId}/>;
    
    case "TodoWrite":
      return <TodoWriteCompactView tool={tool as TodoWriteToolCall} sessionId={sessionId} messageId={messageId} />;
    
    //case "Task":
    //  return null;
    
    case "LS":
      return <LSCompactView tool={tool as LSToolCall}/>;
    
    case "Write":
      return <WriteCompactView tool={tool as WriteToolCall} sessionId={sessionId} messageId={messageId} />;
    
    default:
      if (tool.name.startsWith('mcp__')) {
        return <MCPCompactView tool={tool as MCPToolCall} sessionId={sessionId} messageId={messageId} />;
      }
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

// Component that dispatches to different detailed tool renderers based on tool type
export function DetailedToolBlock({ tool }: { tool: ToolCall }) {
  switch (tool.name) {
    case "Edit":
      return <EditDetailedView tool={tool as EditToolCall} />;

    case "Write":
      return <WriteDetailedView tool={tool as WriteToolCall} />;

    case "Bash":
      return <BashDetailedView tool={tool as BashToolCall} />;

    case "TodoWrite":
      return <TodoWriteDetailedView tool={tool as TodoWriteToolCall} />;

    case "LS":
      return <LSDetailedView tool={tool as LSToolCall} />;

    default:
      // Fallback for tools without detailed views
      return <UnknownToolDetailedView tool={tool} />;
  }
} 