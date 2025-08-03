import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Platform } from 'react-native';
import { Stack } from 'expo-router';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';

interface JsonViewerProps {
    title: string;
    data: any;
    defaultExpanded?: boolean;
}

function JsonViewer({ title, data, defaultExpanded = false }: JsonViewerProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    
    const handleCopy = async () => {
        try {
            await Clipboard.setStringAsync(JSON.stringify(data, null, 2));
            Modal.alert('Copied', 'JSON data copied to clipboard');
        } catch (error) {
            Modal.alert('Error', 'Failed to copy to clipboard');
        }
    };
    
    if (!data) {
        return (
            <Item
                title={title}
                detail="Not available"
                showChevron={false}
            />
        );
    }
    
    return (
        <View style={{ marginBottom: 12 }}>
            <Pressable
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    backgroundColor: 'white',
                }}
                onPress={() => setIsExpanded(!isExpanded)}
            >
                <Ionicons
                    name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                    size={20}
                    color="#8E8E93"
                    style={{ marginRight: 8 }}
                />
                <Text style={{ flex: 1, fontSize: 16, ...Typography.default('semiBold') }}>
                    {title}
                </Text>
                <Pressable
                    onPress={handleCopy}
                    hitSlop={10}
                    style={{ padding: 4 }}
                >
                    <Ionicons name="copy-outline" size={20} color="#007AFF" />
                </Pressable>
            </Pressable>
            
            {isExpanded && (
                <View style={{ 
                    backgroundColor: '#F2F2F7', 
                    paddingHorizontal: 16, 
                    paddingVertical: 12,
                    marginHorizontal: 16,
                    borderRadius: 8,
                    marginTop: -4,
                }}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                        <Text style={{ 
                            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), 
                            fontSize: 12,
                            color: '#000',
                        }}>
                            {JSON.stringify(data, null, 2)}
                        </Text>
                    </ScrollView>
                </View>
            )}
        </View>
    );
}

export default function ExpoConstantsScreen() {
    // Get various manifest types
    const expoConfig = Constants.expoConfig;
    const manifest = Constants.manifest;
    const manifest2 = Constants.manifest2;
    
    // Get Updates manifest if available
    let updatesManifest = null;
    try {
        // @ts-ignore - manifest might not be typed
        updatesManifest = Updates.manifest;
    } catch (e) {
        // expo-updates might not be available
    }
    
    // Get update ID and channel
    let updateId = null;
    let releaseChannel = null;
    let channel = null;
    try {
        // @ts-ignore
        updateId = Updates.updateId;
        // @ts-ignore
        releaseChannel = Updates.releaseChannel;
        // @ts-ignore
        channel = Updates.channel;
    } catch (e) {
        // Properties might not be available
    }
    
    return (
        <>
            <Stack.Screen
                options={{
                    title: 'Expo Constants',
                    headerLargeTitle: false,
                }}
            />
            <ItemList>
                {/* Main Configuration */}
                <ItemGroup title="Configuration">
                    <JsonViewer
                        title="expoConfig (Current)"
                        data={expoConfig}
                        defaultExpanded={true}
                    />
                    <JsonViewer
                        title="manifest (Legacy)"
                        data={manifest}
                    />
                    <JsonViewer
                        title="manifest2"
                        data={manifest2}
                    />
                    {updatesManifest && (
                        <JsonViewer
                            title="Updates Manifest"
                            data={updatesManifest}
                        />
                    )}
                </ItemGroup>
                
                {/* System Constants */}
                <ItemGroup title="System Constants">
                    <Item
                        title="Device ID"
                        detail={Constants.deviceId || 'Not available'}
                        showChevron={false}
                    />
                    <Item
                        title="Session ID"
                        detail={Constants.sessionId}
                        showChevron={false}
                    />
                    <Item
                        title="Installation ID"
                        detail={Constants.installationId}
                        showChevron={false}
                    />
                    <Item
                        title="Is Device"
                        detail={Constants.isDevice ? 'Yes' : 'No'}
                        showChevron={false}
                    />
                    <Item
                        title="Debug Mode"
                        detail={Constants.debugMode ? 'Yes' : 'No'}
                        showChevron={false}
                    />
                    <Item
                        title="App Ownership"
                        detail={Constants.appOwnership || 'N/A'}
                        showChevron={false}
                    />
                    <Item
                        title="Execution Environment"
                        detail={Constants.executionEnvironment || 'N/A'}
                        showChevron={false}
                    />
                </ItemGroup>
                
                {/* Updates Information */}
                <ItemGroup title="Updates Information">
                    <Item
                        title="Update ID"
                        detail={updateId || 'Not available'}
                        showChevron={false}
                    />
                    <Item
                        title="Release Channel"
                        detail={releaseChannel || 'Not available'}
                        showChevron={false}
                    />
                    <Item
                        title="Channel"
                        detail={channel || 'Not available'}
                        showChevron={false}
                    />
                    <Item
                        title="Is Embedded Launch"
                        // @ts-ignore
                        detail={Updates.isEmbeddedLaunch !== undefined ? (Updates.isEmbeddedLaunch ? 'Yes' : 'No') : 'Not available'}
                        showChevron={false}
                    />
                </ItemGroup>
                
                {/* Platform Info */}
                <ItemGroup title="Platform Constants">
                    <JsonViewer
                        title="Platform Constants"
                        data={Constants.platform}
                    />
                </ItemGroup>
                
                {/* System Fonts */}
                <ItemGroup title="System Fonts">
                    <JsonViewer
                        title="Available Fonts"
                        data={Constants.systemFonts}
                    />
                </ItemGroup>
                
                {/* Raw Constants Object */}
                <ItemGroup title="All Constants (Debug)">
                    <JsonViewer
                        title="Full Constants Object"
                        data={Constants}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}