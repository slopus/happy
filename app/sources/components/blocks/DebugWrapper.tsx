import { useConfigStore } from '@/store/configStore';
import React from 'react';
import { View, Text } from 'react-native';

interface DebugWrapperProps {
  debugId?: string;
  debugLabel?: string;
  children: React.ReactNode;
}

export const DebugWrapper: React.FC<DebugWrapperProps> = ({ debugId, debugLabel, children }) => {
  const { showDebugInfo } = useConfigStore();

  return (
    <View>
      {children}
      {showDebugInfo && debugId && (
        <View style={{ 
          marginTop: 4, 
          paddingHorizontal: 8, 
          paddingVertical: 4, 
          backgroundColor: '#EF4444', 
          borderRadius: 4, 
          alignSelf: 'flex-start',
          marginLeft: 16
        }}>
          <Text style={{ 
            fontSize: 10, 
            color: 'white', 
            fontWeight: '600',
            fontFamily: 'monospace'
          }}>
            {debugLabel ? `${debugLabel}: ` : 'ID: '}{debugId}
          </Text>
        </View>
      )}
    </View>
  );
}; 