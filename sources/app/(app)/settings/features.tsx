import { View, Switch, TextInput, Pressable, Alert } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useSettingMutable } from '@/sync/storage';
import { useState } from 'react';

export default function FeaturesSettingsScreen() {
    const [openAIKey, setOpenAIKey] = useSettingMutable('inferenceOpenAIKey');
    const [isEditingAPIKey, setIsEditingAPIKey] = useState(false);
    const [tempOpenAIKey, setTempOpenAIKey] = useState(openAIKey || '');

    const handleSaveAPIKey = () => {
        const trimmedKey = tempOpenAIKey.trim();
        setOpenAIKey(trimmedKey || null);
        setIsEditingAPIKey(false);
        Alert.alert('Success', trimmedKey ? 'OpenAI API key saved successfully' : 'OpenAI API key removed');
    };

    const handleCancelEdit = () => {
        setIsEditingAPIKey(false);
        setTempOpenAIKey(openAIKey || '');
    };
    
    return (
        <ItemList style={{ paddingTop: 0 }}>
            
            {/* Voice Assistant */}
            <ItemGroup title="Voice Assistant" footer="Configure voice control features">
                <Item
                    title="OpenAI API Key"
                    subtitle={openAIKey ? "Key configured" : "Required for voice control"}
                    icon={<Ionicons name="key-outline" size={29} color="#34C759" />}
                    detail={isEditingAPIKey ? undefined : (openAIKey ? "•••••" + openAIKey.slice(-4) : "Not set")}
                    rightElement={isEditingAPIKey ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <TextInput
                                style={{
                                    backgroundColor: '#F2F2F7',
                                    borderRadius: 8,
                                    padding: 8,
                                    width: 200,
                                    fontSize: 14,
                                }}
                                value={tempOpenAIKey}
                                onChangeText={setTempOpenAIKey}
                                placeholder="sk-..."
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry={!isEditingAPIKey}
                            />
                            <Pressable
                                onPress={handleSaveAPIKey}
                                style={{ padding: 8 }}
                            >
                                <Text style={{ color: '#007AFF', fontSize: 16, fontWeight: '600' }}>
                                    Save
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={handleCancelEdit}
                                style={{ padding: 8 }}
                            >
                                <Text style={{ color: '#8E8E93', fontSize: 16 }}>Cancel</Text>
                            </Pressable>
                        </View>
                    ) : undefined}
                    onPress={!isEditingAPIKey ? () => {
                        setIsEditingAPIKey(true);
                        setTempOpenAIKey(openAIKey || '');
                    } : undefined}
                    showChevron={!isEditingAPIKey}
                />
            </ItemGroup>


            {/* Experimental Features */}
            <ItemGroup title="Experimental" footer="These features are in beta and may not work as expected">
                <Item
                    title="Real-time Responses"
                    subtitle="Stream responses as they're generated"
                    icon={<Ionicons name="flash-outline" size={29} color="#FF9500" />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#fff"
                        />
                    }
                />
                <Item
                    title="Voice Input"
                    subtitle="Use voice commands to interact"
                    icon={<Ionicons name="mic-outline" size={29} color="#FF9500" />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#fff"
                        />
                    }
                />
                <Item
                    title="Code Execution"
                    subtitle="Run code snippets directly in the app"
                    icon={<Ionicons name="play-circle-outline" size={29} color="#FF9500" />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#fff"
                        />
                    }
                />
            </ItemGroup>

            {/* Performance Features */}
            <ItemGroup title="Performance" footer="Optimize app performance and battery life">
                <Item
                    title="Aggressive Caching"
                    subtitle="Cache more data for offline use"
                    icon={<Ionicons name="speedometer-outline" size={29} color="#34C759" />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#fff"
                        />
                    }
                />
                <Item
                    title="Background Sync"
                    subtitle="Sync messages in the background"
                    icon={<Ionicons name="sync-outline" size={29} color="#34C759" />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#fff"
                        />
                    }
                />
            </ItemGroup>
        </ItemList>
    );
}