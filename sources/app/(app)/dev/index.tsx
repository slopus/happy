import * as React from 'react';
import { Switch, View, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Application from 'expo-application';

export default function DevScreen() {
    const router = useRouter();
    const [debugMode, setDebugMode] = React.useState(false);
    const [verboseLogging, setVerboseLogging] = React.useState(false);

    const handleClearCache = () => {
        Alert.alert(
            'Clear Cache',
            'Are you sure you want to clear all cached data?',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Clear', style: 'destructive', onPress: () => {
                    console.log('Cache cleared');
                    Alert.alert('Success', 'Cache has been cleared');
                }},
            ]
        );
    };

    return (
        <ItemList>
            {/* App Information */}
            <ItemGroup title="App Information">
                <Item 
                    title="Version"
                    detail={Constants.expoConfig?.version || '1.0.0'}
                />
                <Item 
                    title="Build Number"
                    detail={Application.nativeBuildVersion || 'N/A'}
                />
                <Item 
                    title="SDK Version"
                    detail={Constants.expoConfig?.sdkVersion || 'Unknown'}
                />
                <Item 
                    title="Platform"
                    detail={`${Constants.platform?.ios ? 'iOS' : 'Android'} ${Constants.systemVersion || ''}`}
                />
            </ItemGroup>

            {/* Debug Options */}
            <ItemGroup title="Debug Options">
                <Item 
                    title="Debug Mode"
                    rightElement={
                        <Switch
                            value={debugMode}
                            onValueChange={setDebugMode}
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#FFFFFF"
                        />
                    }
                    showChevron={false}
                />
                <Item 
                    title="Verbose Logging"
                    subtitle="Log all network requests and responses"
                    rightElement={
                        <Switch
                            value={verboseLogging}
                            onValueChange={setVerboseLogging}
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#FFFFFF"
                        />
                    }
                    showChevron={false}
                />
                <Item 
                    title="View Logs"
                    icon={<Ionicons name="document-text-outline" size={28} color="#007AFF" />}
                    onPress={() => console.log('View logs')}
                />
            </ItemGroup>

            {/* Component Demos */}
            <ItemGroup title="Component Demos">
                <Item 
                    title="List Components"
                    subtitle="Demo of Item, ItemGroup, and ItemList"
                    icon={<Ionicons name="list-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/list-demo')}
                />
                <Item 
                    title="Typography"
                    subtitle="All typography styles"
                    icon={<Ionicons name="text-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/typography')}
                />
                <Item 
                    title="Colors"
                    subtitle="Color palette and themes"
                    icon={<Ionicons name="color-palette-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/colors')}
                />
            </ItemGroup>

            {/* Test Features */}
            <ItemGroup title="Test Features" footer="These actions may affect app stability">
                <Item 
                    title="Test Crash"
                    subtitle="Trigger a test crash"
                    destructive={true}
                    icon={<Ionicons name="warning-outline" size={28} color="#FF3B30" />}
                    onPress={() => {
                        Alert.alert(
                            'Test Crash',
                            'This will crash the app. Continue?',
                            [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Crash', style: 'destructive', onPress: () => {
                                    throw new Error('Test crash triggered from dev menu');
                                }},
                            ]
                        );
                    }}
                />
                <Item 
                    title="Clear Cache"
                    subtitle="Remove all cached data"
                    icon={<Ionicons name="trash-outline" size={28} color="#FF9500" />}
                    onPress={handleClearCache}
                />
                <Item 
                    title="Reset App State"
                    subtitle="Clear all user data and preferences"
                    destructive={true}
                    icon={<Ionicons name="refresh-outline" size={28} color="#FF3B30" />}
                    onPress={() => {
                        Alert.alert(
                            'Reset App',
                            'This will delete all data. Are you sure?',
                            [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Reset', style: 'destructive', onPress: () => {
                                    console.log('App state reset');
                                }},
                            ]
                        );
                    }}
                />
            </ItemGroup>

            {/* Network */}
            <ItemGroup title="Network">
                <Item 
                    title="API Endpoint"
                    detail="Production"
                    onPress={() => console.log('Switch endpoint')}
                />
                <Item 
                    title="Force Refresh"
                    subtitle="Reload all data from server"
                    icon={<Ionicons name="cloud-download-outline" size={28} color="#007AFF" />}
                    onPress={() => console.log('Force refresh')}
                />
            </ItemGroup>
        </ItemList>
    );
}