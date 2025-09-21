import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout } from '@/components/layout';
import { ZenHeader } from './components/ZenHeader';

export const ZenHome = () => {
    const insets = useSafeAreaInsets();
    return (
        <>
            <ZenHeader />
            <View style={{ flexDirection: 'row', flex: 1, justifyContent: 'center' }}>
                <View style={{ flex: 1, maxWidth: layout.maxWidth, alignSelf: 'stretch' }}>
                    
                </View>
            </View>
        </>
    );
};