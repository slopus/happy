import React from 'react';
import { Text, View, ViewStyle } from 'react-native';
import { Typography } from '@/constants/Typography';

interface PlusPlusProps {
    fontSize: number;
    style?: ViewStyle;
}

export const PlusPlus: React.FC<PlusPlusProps> = ({ fontSize, style }) => {
    return (
        <View style={[{ marginLeft: 4, marginTop: 2 }, style]}>
            <Text
                style={[
                    {
                        fontSize: fontSize * 0.8,
                        ...Typography.logo(),
                        fontWeight: 'bold',
                        color: 'transparent',
                    },
                    // @ts-ignore - Web-specific gradient styles
                    {
                        backgroundImage: 'linear-gradient(to right, #8B5CF6, #EC4899, #F59E0B, #10B981)',
                        backgroundClip: 'text',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                    } as any
                ]}
            >
                ++
            </Text>
        </View>
    );
};