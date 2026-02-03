import React from 'react';
import { Text, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { Typography } from '@/constants/Typography';

interface PlusPlusProps {
    fontSize: number;
    style?: ViewStyle;
}

export const PlusPlus: React.FC<PlusPlusProps> = ({ fontSize, style }) => {
    return (
        <MaskedView
            style={[{ marginLeft: 4, marginTop: 2 }, style]}
            maskElement={
                <Text style={{ 
                    fontSize: fontSize * 0.8,
                    ...Typography.logo(),
                    fontWeight: 'bold'
                }}>
                    ++
                </Text>
            }
        >
            <LinearGradient
                colors={['#8B5CF6', '#EC4899', '#F59E0B', '#10B981']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={{ width: 30, height: fontSize }}
            />
        </MaskedView>
    );
};