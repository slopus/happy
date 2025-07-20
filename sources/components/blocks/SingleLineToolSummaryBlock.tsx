import React from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';

// Block-level component that provides chrome/wrapper and navigation
export function SingleLineToolSummaryBlock({ children, sessionId, messageId }: { children: React.ReactNode, sessionId: string, messageId: string }) {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.push(`/session/${sessionId}/message/${messageId}`)}
      className="border-2 border-transparent active:border-neutral-200 active:bg-neutral-50 rounded-lg bg-white flex-row items-center justify-between py-2"
    >
      {children}

      <View className="shrink-0">
      </View>
    </Pressable>
  );
} 