import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { Slot } from 'expo-router';
import { Dimensions } from 'react-native';

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const enabled = auth.isAuthenticated && isTablet;
    const windowWidth = Dimensions.get('window').width;

    const drawerNavigationOptions = (p: any) => {
        return {
            lazy: false,
            headerShown: false,
            drawerType: enabled ? 'permanent' : 'front',
            drawerStyle: {
                backgroundColor: 'white',
                borderRightWidth: 0,
                width: Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360),
            },
            swipeEnabled: false
        } as any;
    };

    if (!enabled) {
        return (
            <Slot />
        )
    }

    return (
        <Drawer
            screenOptions={drawerNavigationOptions}
            drawerContent={() => <SidebarView />}
        />
    )
});