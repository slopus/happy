import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/storageTypes';
import { Metadata } from '@/sync/storageTypes';

// Block-level component that provides chrome/wrapper and navigation
export function CompactToolCallBlock({ tool, metadata, sessionId, messageId }: { tool: ToolCall; metadata: Metadata | null, sessionId: string, messageId: string }) {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.push(`/session/${sessionId}/message/${messageId}`)}
      className="border border-gray-300 rounded-lg bg-white overflow-hidden flex-row items-center justify-between px-3 py-3 active:scale-95 active:opacity-70"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2 }}>
        <Text style={{ fontSize: 16, color: '#6b7280', fontStyle: 'italic' }}>
          {tool.name}
        </Text>
      </View>

      <View className="flex-row items-center">
        <Ionicons 
          name="chevron-forward" 
          size={12} 
          color="#6b7280"
        />
      </View>
    </Pressable>
  );
} 