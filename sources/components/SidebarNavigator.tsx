import { Slot, useRouter } from 'expo-router';
import { Drawer } from 'expo-router/drawer';
import * as React from 'react';
import { useWindowDimensions } from 'react-native';

import { SidebarView } from './SidebarView';

import { useAuth } from '@/auth/AuthContext';
import { useIsTablet } from '@/utils/responsive';



export const SidebarNavigator = React.memo(() => {
  const auth = useAuth();
  const isTablet = useIsTablet();
  const router = useRouter();
  const showPermanentDrawer = auth.isAuthenticated && auth.isSessionUnlocked && isTablet;

  // Handle password unlock flow
  React.useEffect(() => {
    if (auth.isAuthenticated && auth.isPasswordProtected && !auth.isSessionUnlocked) {
      // User is authenticated but session is locked, redirect to password unlock
      router.replace('/password/unlock');
    }
  }, [auth.isAuthenticated, auth.isPasswordProtected, auth.isSessionUnlocked, router]);
  const { width: windowWidth } = useWindowDimensions();

  // Calculate drawer width only when needed
  const drawerWidth = React.useMemo(() => {
    if (!showPermanentDrawer) return 280; // Default width for hidden drawer
    return Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
  }, [windowWidth, showPermanentDrawer]);

  const drawerNavigationOptions = React.useMemo(() => {
    if (!showPermanentDrawer) {
      // When drawer is hidden, use minimal configuration
      return {
        lazy: false,
        headerShown: false,
        drawerType: 'front' as const,
        swipeEnabled: false,
        drawerStyle: {
          width: 0,
          display: 'none' as const,
        },
      };
    }
        
    // When drawer is permanent
    return {
      lazy: false,
      headerShown: false,
      drawerType: 'permanent' as const,
      drawerStyle: {
        backgroundColor: 'white',
        borderRightWidth: 0,
        width: drawerWidth,
      },
      swipeEnabled: false,
      drawerActiveTintColor: 'transparent',
      drawerInactiveTintColor: 'transparent',
      drawerItemStyle: { display: 'none' as const },
      drawerLabelStyle: { display: 'none' as const },
    };
  }, [showPermanentDrawer, drawerWidth]);

  // Always render SidebarView but hide it when not needed
  const drawerContent = React.useCallback(
    () => <SidebarView />,
    [],
  );

  return (
    <Drawer
      screenOptions={drawerNavigationOptions}
      drawerContent={showPermanentDrawer ? drawerContent : undefined}
    />
  );
});