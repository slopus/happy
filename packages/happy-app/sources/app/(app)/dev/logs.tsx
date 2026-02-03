import * as React from 'react';
import { View, Text, FlatList, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { log } from '@/log';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Item } from '@/components/Item';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';

export default function LogsScreen() {
    const [logs, setLogs] = React.useState<string[]>([]);
    const flatListRef = React.useRef<FlatList>(null);

    // Subscribe to log changes
    React.useEffect(() => {
        // Add some sample logs if empty (for demo purposes)
        if (log.getCount() === 0) {
            log.log('Logger initialized');
            log.log('Sample debug message');
            log.log('Application started successfully');
        }

        // Initial load
        setLogs(log.getLogs());

        // Subscribe to changes
        const unsubscribe = log.onChange(() => {
            setLogs(log.getLogs());
        });

        return unsubscribe;
    }, []);

    // Auto-scroll to bottom when new logs arrive
    React.useEffect(() => {
        if (logs.length > 0) {
            setTimeout(() => {
                flatListRef.current?.scrollToEnd({ animated: false });
            }, 100);
        }
    }, [logs.length]);

    const handleClear = async () => {
        const confirmed = await Modal.confirm(
            'Clear Logs',
            'Are you sure you want to clear all logs?',
            { confirmText: 'Clear', destructive: true }
        );
        if (confirmed) {
            log.clear();
        }
    };

    const handleCopyAll = async () => {
        if (logs.length === 0) {
            Modal.alert('No Logs', 'There are no logs to copy');
            return;
        }

        const allLogs = logs.join('\n');
        await Clipboard.setStringAsync(allLogs);
        Modal.alert('Copied', `${logs.length} log entries copied to clipboard`);
    };

    const handleAddTestLog = () => {
        const timestamp = new Date().toLocaleTimeString();
        log.log(`Test log entry at ${timestamp}`);
    };

    const renderLogItem = ({ item, index }: { item: string; index: number }) => (
        <View style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: '#F0F0F0'
        }}>
            <Text style={{
                fontFamily: 'IBMPlexMono-Regular',
                fontSize: 12,
                color: '#333',
                lineHeight: 16
            }}>
                {item}
            </Text>
        </View>
    );

    return (
        <View style={{ flex: 1, backgroundColor: '#F5F5F5' }}>
            {/* Header with actions */}
            <ItemList>
                <ItemGroup title={`Logs (${logs.length})`}>
                    <Item 
                        title="Add Test Log"
                        subtitle="Add a test log entry with timestamp"
                        icon={<Ionicons name="add-circle-outline" size={24} color="#34C759" />}
                        onPress={handleAddTestLog}
                    />
                    <Item 
                        title="Copy All Logs"
                        icon={<Ionicons name="copy-outline" size={24} color="#007AFF" />}
                        onPress={handleCopyAll}
                        disabled={logs.length === 0}
                    />
                    <Item 
                        title="Clear All Logs"
                        icon={<Ionicons name="trash-outline" size={24} color="#FF3B30" />}
                        onPress={handleClear}
                        disabled={logs.length === 0}
                        destructive={true}
                    />
                </ItemGroup>
            </ItemList>

            {/* Logs display */}
            <View style={{ flex: 1, backgroundColor: '#FFFFFF', margin: 16, borderRadius: 8 }}>
                {logs.length === 0 ? (
                    <View style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        padding: 32
                    }}>
                        <Ionicons name="document-text-outline" size={48} color="#C0C0C0" />
                        <Text style={{
                            fontSize: 16,
                            color: '#999',
                            marginTop: 16,
                            textAlign: 'center'
                        }}>
                            No logs yet
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: '#C0C0C0',
                            marginTop: 8,
                            textAlign: 'center'
                        }}>
                            Logs will appear here as they are generated
                        </Text>
                    </View>
                ) : (
                    <FlatList
                        ref={flatListRef}
                        data={logs}
                        renderItem={renderLogItem}
                        keyExtractor={(item, index) => index.toString()}
                        style={{ flex: 1 }}
                        contentContainerStyle={{ paddingVertical: 8 }}
                        showsVerticalScrollIndicator={true}
                    />
                )}
            </View>
        </View>
    );
}