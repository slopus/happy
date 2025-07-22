import React from 'react';
import { View, Text } from 'react-native';

import { BashCompactView, BashDetailedView, type BashToolCall } from './ToolCalls/Bash';
import { EditCompactView, EditDetailedView, type EditToolCall } from './ToolCalls/Edit';
import { ReadCompactView, ReadDetailedView, type ReadToolCall } from './ToolCalls/Read';
import { GrepCompactView, GrepDetailedView, type GrepToolCall } from './ToolCalls/Grep';
import { TodoWriteCompactView, TodoWriteDetailedView, type TodoWriteToolCall } from './ToolCalls/TodoWrite';
import { LSCompactView, LSDetailedView, type LSToolCall } from './ToolCalls/LS';
import { WriteCompactView, WriteDetailedView, WriteToolCall } from './ToolCalls/Write';
import { MCPCompactView, MCPDetailedView, MCPToolCall } from './ToolCalls/MCP';
import { UnknownToolDetailedView } from './ToolCalls/Unknown';
import { TaskCompactView, TaskDetailedView, type TaskToolCall } from './ToolCalls/Task';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';

// Component that dispatches to different tool renderers based on tool type
export function CompactToolBlock({ tool, sessionId, messageId, metadata }: { tool: ToolCall, sessionId: string, messageId: string, metadata: Metadata | null }) {
  switch (tool.name) {
    case 'Bash':
      return <BashCompactView tool={tool as BashToolCall} sessionId={sessionId} messageId={messageId} />;

    case 'Edit':
      return <EditCompactView tool={tool as EditToolCall} sessionId={sessionId} messageId={messageId} metadata={metadata} />;

    case "Read":
      return <ReadCompactView tool={tool as ReadToolCall} sessionId={sessionId} messageId={messageId} />;

    case "Grep":
      return <GrepCompactView tool={tool as GrepToolCall} sessionId={sessionId} messageId={messageId} />;

    case "TodoWrite":
      return <TodoWriteCompactView tool={tool as TodoWriteToolCall} sessionId={sessionId} messageId={messageId} />;

    case "Task":
      return <TaskCompactView tool={tool as TaskToolCall} sessionId={sessionId} messageId={messageId} />;

    case "LS":
      return <LSCompactView tool={tool as LSToolCall} />;

    case "Write":
      return <WriteCompactView tool={tool as WriteToolCall} sessionId={sessionId} messageId={messageId} />;
  }
  if (tool.name.startsWith('mcp__')) {
   return <MCPCompactView tool={tool as MCPToolCall} sessionId={sessionId} messageId={messageId} />;
  }
  // Fallback for uknown tool types
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2 }}>
      <Text style={{ fontSize: 16, color: '#6b7280', fontStyle: 'italic' }}>
        {tool.name}
      </Text>
    </View>
  );
}

// Component that dispatches to different detailed tool renderers based on tool type
export function DetailedToolBlock({ tool, metadata }: { tool: ToolCall, metadata: Metadata | null }) {
  switch (tool.name) {
    case "Edit":
      return <EditDetailedView tool={tool as EditToolCall} metadata={metadata} />;

    case "Read":
      return <ReadDetailedView tool={tool as ReadToolCall} />;

    case "Write":
      return <WriteDetailedView tool={tool as WriteToolCall} />;

    case "Bash":
      return <BashDetailedView tool={tool as BashToolCall} />;

    case "TodoWrite":
      return <TodoWriteDetailedView tool={tool as TodoWriteToolCall} />;

    case "Grep":
      return <GrepDetailedView tool={tool as GrepToolCall} />;

    case "LS":
      return <LSDetailedView tool={tool as LSToolCall} />;

    case "Task":
      return <TaskDetailedView tool={tool as TaskToolCall} />;

    default:
      if (tool.name.startsWith('mcp__')) {
        return <MCPDetailedView tool={tool as MCPToolCall} />;
      }
      // Fallback for tools without detailed views
      return <UnknownToolDetailedView tool={tool} />;
  }
} 