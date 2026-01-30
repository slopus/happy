import * as React from 'react';
import { View, Pressable } from 'react-native';
import { OpenClawView } from '@/components/OpenClawView';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default React.memo(function OpenClawPage() {
    const { theme } = useUnistyles();
    const router = useRouter();

    return (
        <View style={{ flex: 1 }}>
            <Stack.Screen
                options={{
                    headerRight: () => (
                        <Pressable
                            onPress={() => router.push('/openclaw/add')}
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
            <OpenClawView />
        </View>
    );
});
