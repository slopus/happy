import * as React from 'react';
import { TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { showToast } from '@/components/Toast';
import { hapticsLight } from '@/components/haptics';

export default React.memo(function ToastDemoScreen() {
    const [customMessage, setCustomMessage] = React.useState('');

    return (
        <ItemList>
            <ItemGroup title="Presets">
                <Item
                    title="Default (Copied)"
                    icon={<Ionicons name="copy-outline" size={28} color="#007AFF" />}
                    onPress={() => { hapticsLight(); showToast(); }}
                />
                <Item
                    title="Custom Message"
                    icon={<Ionicons name="chatbubble-outline" size={28} color="#007AFF" />}
                    onPress={() => { hapticsLight(); showToast('Settings saved successfully'); }}
                />
                <Item
                    title="Long Message"
                    icon={<Ionicons name="text-outline" size={28} color="#007AFF" />}
                    onPress={() => { hapticsLight(); showToast('This is a much longer toast message to test wrapping'); }}
                />
            </ItemGroup>

            <ItemGroup title="Keyboard Test" footer="Type in the input below, then tap 'Show Toast' to verify it appears above the keyboard">
                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <TextInput
                        value={customMessage}
                        onChangeText={setCustomMessage}
                        placeholder="Type here to open keyboard..."
                        style={{ fontSize: 16, padding: 12, borderRadius: 8, backgroundColor: 'rgba(128,128,128,0.1)' }}
                    />
                </View>
                <Item
                    title="Show Toast While Keyboard Open"
                    icon={<Ionicons name="notifications-outline" size={28} color="#34C759" />}
                    onPress={() => { hapticsLight(); showToast(customMessage || 'Toast above keyboard!'); }}
                />
            </ItemGroup>
        </ItemList>
    );
});
