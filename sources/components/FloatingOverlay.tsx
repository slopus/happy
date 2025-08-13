import * as React from 'react';
import { Platform } from 'react-native';
import Animated from 'react-native-reanimated';

interface FloatingOverlayProps {
    children: React.ReactNode;
    maxHeight?: number;
    showScrollIndicator?: boolean;
    keyboardShouldPersistTaps?: boolean | 'always' | 'never' | 'handled';
}

export const FloatingOverlay = React.memo((props: FloatingOverlayProps) => {
    const { 
        children, 
        maxHeight = 240, 
        showScrollIndicator = false, 
        keyboardShouldPersistTaps = 'handled' 
    } = props;

    // Container styles with shadow
    const containerStyle = {
        backgroundColor: 'white',
        borderRadius: 12,
        maxHeight,
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: -2 },
                shadowOpacity: 0.1,
                shadowRadius: 8,
            },
            android: {
                elevation: 4,
            },
            default: {
                boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.1)',
            },
        }),
        borderWidth: Platform.OS === 'web' ? 0 : 0.5,
        borderColor: 'rgba(0, 0, 0, 0.1)',
        overflow: 'hidden' as const,
    };

    return (
        <Animated.View style={containerStyle}>
            <Animated.ScrollView
                style={{ maxHeight }}
                keyboardShouldPersistTaps={keyboardShouldPersistTaps}
                showsVerticalScrollIndicator={showScrollIndicator}
            >
                {children}
            </Animated.ScrollView>
        </Animated.View>
    );
});