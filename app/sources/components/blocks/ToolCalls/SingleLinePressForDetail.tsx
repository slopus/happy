import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

// Block-level component that provides chrome/wrapper and navigation
export function SingleLineToolSummaryBlock({ children, sessionId, messageId }: { children: React.ReactNode, sessionId: string, messageId: string }) {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.push(`/session/${sessionId}/message/${messageId}`)}
      className="border border-gray-300 rounded-lg bg-white overflow-hidden flex-row items-center justify-between px-3 py-3 active:scale-95 active:opacity-70"
    >
      {children}

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