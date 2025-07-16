import React from 'react';
import { View, Text } from 'react-native';
import { type ToolCall } from '@/sync/storageTypes';

import { BashCompactView } from './ToolBash';

// Component that dispatches to different tool renderers based on tool type
export function CompactToolView({ tool }: { tool: ToolCall }) {
  switch (tool.name) {
    case 'Bash':
      return <BashCompactView tool={tool} />;
    
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