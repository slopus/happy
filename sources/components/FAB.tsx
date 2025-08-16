import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const FAB = React.memo(({ onPress }: { onPress: () => void }) => {
    const safeArea = useSafeAreaInsets();
    return (
        <View
            style={{
                position: 'absolute',
                bottom: safeArea.bottom + 16,
                right: 16,
            }}
        >
            <Pressable
                style={({ pressed }) => ({
                    backgroundColor: pressed ? 'rgb(100,100,100)' : 'black',
                    borderRadius: 20,
                    width: 56,
                    height: 56,
                    padding: 16,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.25,
                    shadowRadius: 3.84,
                    elevation: 5,
                })}
                onPress={onPress}
            >
                <Ionicons name="add" size={24} color="white" />
            </Pressable>
        </View>
    )
});