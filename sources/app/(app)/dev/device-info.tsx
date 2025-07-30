import React from 'react';
import { View, Text, ScrollView, Dimensions, Platform, PixelRatio } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import Constants from 'expo-constants';
import { useIsTablet, getDeviceType } from '@/utils/responsive';
import { layout } from '@/components/layout';

export default function DeviceInfo() {
    const insets = useSafeAreaInsets();
    const { width, height } = Dimensions.get('window');
    const screenDimensions = Dimensions.get('screen');
    const pixelDensity = PixelRatio.get();
    const isTablet = useIsTablet();
    
    // Calculate diagonal size
    const widthInches = screenDimensions.width / (pixelDensity * 160);
    const heightInches = screenDimensions.height / (pixelDensity * 160);
    const diagonalInches = Math.sqrt(widthInches * widthInches + heightInches * heightInches);
    
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
                        detail={isTablet ? 'Tablet' : 'Phone'}
                    />
                    <Item
                        title="Diagonal Size"
                        detail={`${diagonalInches.toFixed(1)} inches`}
                    />
                    <Item
                        title="Pixel Density"
                        detail={`${pixelDensity}x`}
                    />
                    <Item
                        title="Width (inches)"
                        detail={`${widthInches.toFixed(1)}"`}
                    />
                    <Item
                        title="Height (inches)"
                        detail={`${heightInches.toFixed(1)}"`}
                    />
                    <Item
                        title="Layout Max Width"
                        detail={`${layout.maxWidth}px`}
                    />
                </ItemGroup>

                <ItemGroup title="Screen Dimensions">
                    <Item
                        title="Window Width"
                        detail={`${width}px`}
                    />
                    <Item
                        title="Window Height"
                        detail={`${height}px`}
                    />
                    <Item
                        title="Screen Width"
                        detail={`${screenDimensions.width}px`}
                    />
                    <Item
                        title="Screen Height"
                        detail={`${screenDimensions.height}px`}
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