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
      className="border-2 border-transparent active:border-neutral-200 active:bg-neutral-50 rounded-lg bg-white flex-row items-center justify-between px-3 py-2 border-transparent"
    >
      {children}

      <Ionicons 
        name="chevron-forward" 
        size={12} 
        color="#6b7280"
      />
    </Pressable>
  );
} 