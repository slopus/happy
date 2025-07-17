import React from 'react';
import { View, Text } from 'react-native';
import { type ToolCall } from '@/sync/storageTypes';

import { BashCompactView } from './ToolCalls/Bash';
import { EditCompactView } from './ToolCalls/Edit';
import { ReadCompactView } from './ToolCalls/Read';

// Component that dispatches to different tool renderers based on tool type
export function RenderToolV4({ tool, sessionId, messageId }: { tool: ToolCall, sessionId: string, messageId: string }) {
  switch (tool.name) {
    case 'Bash':
      return <BashCompactView tool={tool} sessionId={sessionId} messageId={messageId} />;
    
    case 'Edit':
      return <EditCompactView tool={tool} sessionId={sessionId} messageId={messageId} />;
      
    case "Read":
      return <ReadCompactView tool={tool}/>;
    
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