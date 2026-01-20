import React from 'react';
import { View, Text, ScrollView, Dimensions, Platform, PixelRatio } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import Constants from 'expo-constants';
import { useIsTablet, getDeviceType, calculateDeviceDimensions, useHeaderHeight } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { isRunningOnMac } from '@/utils/platform';

export default function DeviceInfo() {
    const insets = useSafeAreaInsets();
    const { width, height } = Dimensions.get('window');
    const screenDimensions = Dimensions.get('screen');
    const pixelDensity = PixelRatio.get();
    const isTablet = useIsTablet();
    const deviceType = getDeviceType();
    const headerHeight = useHeaderHeight();
    const isRunningOnMacCatalyst = isRunningOnMac();
    
    // Calculate device dimensions using the correct function
    const dimensions = calculateDeviceDimensions({
        widthPoints: screenDimensions.width,
        heightPoints: screenDimensions.height,
        pointsPerInch: Platform.OS === 'ios' ? 163 : 160
    });
    
    const { widthInches, heightInches, diagonalInches } = dimensions;
    
    return (
        <>
            <Stack.Screen
                options={{
                    title: 'Device Info',
                    headerLargeTitle: false,
                }}
            />
            <ItemList>
                <ItemGroup title="Safe Area Insets">
                    <Item
                        title="Top"
                        detail={`${insets.top}px`}
                    />
                    <Item
                        title="Bottom"
                        detail={`${insets.bottom}px`}
                    />
                    <Item
                        title="Left"
                        detail={`${insets.left}px`}
                    />
                    <Item
                        title="Right"
                        detail={`${insets.right}px`}
                    />
                </ItemGroup>

                <ItemGroup title="Device Detection">
                    <Item
                        title="Device Type"
                        detail={deviceType === 'tablet' ? 'Tablet' : 'Phone'}
                    />
                    <Item
                        title="Detection Method"
                        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
                        detail={Platform.OS === 'ios' && Platform.isPad ? 'iOS isPad' : `${diagonalInches.toFixed(1)}" diagonal`}
                    />
                    <Item
                        title="Mac Catalyst"
                        detail={isRunningOnMacCatalyst ? 'Yes' : 'No'}
                    />
                    <Item
                        title="Header Height"
                        detail={`${headerHeight} points`}
                    />
                    <Item
                        title="Diagonal Size"
                        detail={`${diagonalInches.toFixed(2)} inches`}
                    />
                    <Item
                        title="Width (inches)"
                        detail={`${widthInches.toFixed(2)}"`}
                    />
                    <Item
                        title="Height (inches)"
                        detail={`${heightInches.toFixed(2)}"`}
                    />
                    <Item
                        title="Pixel Density"
                        detail={`${pixelDensity}x`}
                    />
                    <Item
                        title="Points per Inch"
                        detail={Platform.OS === 'ios' ? '163' : '160'}
                    />
                    <Item
                        title="Layout Max Width"
                        detail={`${layout.maxWidth}px`}
                    />
                </ItemGroup>

                <ItemGroup title="Screen Dimensions">
                    <Item
                        title="Window Width"
                        detail={`${width} points`}
                    />
                    <Item
                        title="Window Height"
                        detail={`${height} points`}
                    />
                    <Item
                        title="Screen Width"
                        detail={`${screenDimensions.width} points`}
                    />
                    <Item
                        title="Screen Height"
                        detail={`${screenDimensions.height} points`}
                    />
                    <Item
                        title="Physical Pixels (width)"
                        detail={`${Math.round(screenDimensions.width * pixelDensity)}px`}
                    />
                    <Item
                        title="Physical Pixels (height)"
                        detail={`${Math.round(screenDimensions.height * pixelDensity)}px`}
                    />
                    <Item
                        title="Aspect Ratio"
                        detail={`${(height / width).toFixed(3)}`}
                    />
                </ItemGroup>

                <ItemGroup title="Platform Info">
                    <Item
                        title="Platform"
                        detail={Platform.OS}
                    />
                    <Item
                        title="Version"
                        detail={Platform.Version?.toString() || 'N/A'}
                    />
                    {Platform.OS === 'ios' && (
                        <>
                            <Item
                                title="iOS Interface"
                                // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
                                detail={Platform.isPad ? 'iPad' : 'iPhone'}
                            />
                            <Item
                                title="iOS Version"
                                detail={Platform.Version?.toString() || 'N/A'}
                            />
                        </>
                    )}
                    {Platform.OS === 'android' && (
                        <Item
                            title="API Level"
                            detail={Platform.Version?.toString() || 'N/A'}
                        />
                    )}
                </ItemGroup>

                <ItemGroup title="App Info">
                    <Item
                        title="App Version"
                        detail={Constants.expoConfig?.version || 'N/A'}
                    />
                    <Item
                        title="SDK Version"
                        detail={Constants.expoConfig?.sdkVersion || 'N/A'}
                    />
                    <Item
                        title="Build Number"
                        detail={Constants.expoConfig?.ios?.buildNumber || Constants.expoConfig?.android?.versionCode?.toString() || 'N/A'}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}