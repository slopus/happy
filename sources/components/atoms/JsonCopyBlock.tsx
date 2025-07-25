import React from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';

interface JsonCopyBlockProps {
    data: any;
    title?: string;
}

export function JsonCopyBlock({ data, title = "Debug Information" }: JsonCopyBlockProps) {
    const handleCopyJson = async () => {
        try {
            const jsonString = JSON.stringify(data, null, 2);
            await Clipboard.setStringAsync(jsonString);
            Alert.alert('Success', 'JSON data copied to clipboard');
        } catch (error) {
            Alert.alert('Error', 'Failed to copy JSON data');
        }
    };

    return (
        <View style={{ 
            backgroundColor: '#F2F2F7', 
            borderRadius: 8, 
            padding: 16, 
            marginVertical: 8 
        }}>
            <View style={{ 
                flexDirection: 'row', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                marginBottom: 12
            }}>
                <Text style={{
                    fontSize: 16,
                    fontWeight: '600',
                    color: '#000',
                    ...Typography.default('semiBold')
                }}>
                    {title}
                </Text>
                <Pressable
                    onPress={handleCopyJson}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: '#007AFF',
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderRadius: 6
                    }}
                    hitSlop={10}
                >
                    <Ionicons name="copy-outline" size={16} color="white" />
                    <Text style={{
                        color: 'white',
                        fontSize: 14,
                        fontWeight: '500',
                        marginLeft: 4,
                        ...Typography.default('semiBold')
                    }}>
                        Copy
                    </Text>
                </Pressable>
            </View>
            
            <View style={{
                backgroundColor: 'white',
                borderRadius: 6,
                padding: 12,
                borderWidth: 1,
                borderColor: '#D1D1D6'
            }}>
                <Text style={{
                    fontSize: 12,
                    color: '#3C3C43',
                    fontFamily: 'IBMPlexMono-Regular',
                    lineHeight: 16
                }}>
                    {JSON.stringify(data, null, 2)}
                </Text>
            </View>
        </View>
    );
} 