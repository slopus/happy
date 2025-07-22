import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';

interface UpdateBannerProps {
    onReload: () => void;
}

export function UpdateBanner({ onReload }: UpdateBannerProps) {
    return (
        <View style={{
            backgroundColor: '#4CAF50',
            paddingHorizontal: 16,
            paddingVertical: 12,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <Ionicons name="download-outline" size={20} color="white" style={{ marginRight: 12 }} />
                <Text style={{ color: 'white', fontSize: 14, flex: 1 }}>
                    A new version is available
                </Text>
            </View>
            <Pressable
                onPress={onReload}
                style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.2)',
                    paddingHorizontal: 16,
                    paddingVertical: 6,
                    borderRadius: 16,
                }}
            >
                <Text style={{ color: 'white', fontSize: 14, fontWeight: '600' }}>
                    Update
                </Text>
            </Pressable>
        </View>
    );
}