import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';

export function EmptySessionsTablet() {
    return (
        <View style={{ 
            flex: 1, 
            justifyContent: 'center', 
            alignItems: 'center',
            paddingHorizontal: 48
        }}>
            <Ionicons 
                name="terminal-outline" 
                size={64} 
                color="#E5E5E7" 
                style={{ marginBottom: 24 }}
            />
            
            <Text style={{ 
                fontSize: 20, 
                color: '#8E8E93',
                textAlign: 'center',
                marginBottom: 8,
                ...Typography.default('regular')
            }}>
                No active sessions
            </Text>
            
            <Text style={{ 
                fontSize: 16, 
                color: '#C7C7CC',
                textAlign: 'center',
                marginBottom: 24,
                ...Typography.default()
            }}>
                Open a new terminal on your computer to start session.
            </Text>
        </View>
    );
}