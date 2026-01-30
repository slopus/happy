import * as React from 'react';
import { View, Pressable } from 'react-native';
import { MoltbotView } from '@/components/MoltbotView';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default React.memo(function MoltbotPage() {
    const { theme } = useUnistyles();
    const router = useRouter();

    return (
        <View style={{ flex: 1 }}>
            <Stack.Screen
                options={{
                    headerRight: () => (
                        <Pressable
                            onPress={() => router.push('/moltbot/add')}
                            hitSlop={15}
                        >
                            <Ionicons
                                name="add-outline"
                                size={24}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    ),
                }}
            />
            <MoltbotView />
        </View>
    );
});
