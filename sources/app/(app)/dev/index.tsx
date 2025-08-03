import * as React from 'react';
import { Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { useLocalSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';

export default function DevScreen() {
    const router = useRouter();
    const [debugMode, setDebugMode] = useLocalSettingMutable('debugMode');
    const [verboseLogging, setVerboseLogging] = React.useState(false);
    const anonymousId = sync.encryption!.anonID;

    const handleClearCache = async () => {
        const confirmed = await Modal.confirm(
            'Clear Cache',
            'Are you sure you want to clear all cached data?',
            { confirmText: 'Clear', destructive: true }
        );
        if (confirmed) {
            console.log('Cache cleared');
            Modal.alert('Success', 'Cache has been cleared');
        }
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
                <Item 
                    title="Anonymous ID"
                    detail={anonymousId}
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
                    title="Device Info"
                    subtitle="Safe area insets and device parameters"
                    icon={<Ionicons name="phone-portrait-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/device-info')}
                />
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
                <Item 
                    title="Message Demos"
                    subtitle="Various message types and components"
                    icon={<Ionicons name="chatbubbles-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/messages-demo')}
                />
                <Item 
                    title="Inverted List Test"
                    subtitle="Test inverted FlatList with keyboard"
                    icon={<Ionicons name="swap-vertical-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/inverted-list')}
                />
                <Item 
                    title="Atomic Components"
                    subtitle="Showcase of all atomic UI components"
                    icon={<Ionicons name="shapes-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/atoms')}
                />
                <Item 
                    title="Diff View"
                    subtitle="Text diff viewer component demo"
                    icon={<Ionicons name="git-compare-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/diff-demo')}
                />
                <Item 
                    title="Tool Views"
                    subtitle="Tool call visualization components"
                    icon={<Ionicons name="construct-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/tools2')}
                />
                <Item 
                    title="Shimmer View"
                    subtitle="Shimmer loading effects with masks"
                    icon={<Ionicons name="sparkles-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/shimmer-demo')}
                />
                <Item 
                    title="Modal System"
                    subtitle="Alert, confirm, and custom modals"
                    icon={<Ionicons name="albums-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/modal-demo')}
                />
                <Item 
                    title="Unit Tests"
                    subtitle="Run tests in the app environment"
                    icon={<Ionicons name="flask-outline" size={28} color="#34C759" />}
                    onPress={() => router.push('/dev/tests')}
                />
            </ItemGroup>

            {/* Test Features */}
            <ItemGroup title="Test Features" footer="These actions may affect app stability">
                <Item 
                    title="Test Crash"
                    subtitle="Trigger a test crash"
                    destructive={true}
                    icon={<Ionicons name="warning-outline" size={28} color="#FF3B30" />}
                    onPress={async () => {
                        const confirmed = await Modal.confirm(
                            'Test Crash',
                            'This will crash the app. Continue?',
                            { confirmText: 'Crash', destructive: true }
                        );
                        if (confirmed) {
                            throw new Error('Test crash triggered from dev menu');
                        }
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
                    onPress={async () => {
                        const confirmed = await Modal.confirm(
                            'Reset App',
                            'This will delete all data. Are you sure?',
                            { confirmText: 'Reset', destructive: true }
                        );
                        if (confirmed) {
                            console.log('App state reset');
                        }
                    }}
                />
            </ItemGroup>

            {/* System */}
            <ItemGroup title="System">
                <Item 
                    title="Purchases"
                    subtitle="View subscriptions and entitlements"
                    icon={<Ionicons name="card-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/purchases')}
                />
                <Item 
                    title="Expo Constants"
                    subtitle="View expoConfig, manifests, and system constants"
                    icon={<Ionicons name="information-circle-outline" size={28} color="#007AFF" />}
                    onPress={() => router.push('/dev/expo-constants')}
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