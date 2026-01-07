import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';

type MessageSendMode = 'agent_queue' | 'interrupt' | 'server_pending';

export default function MessageSendingSettingsScreen() {
    const [messageSendMode, setMessageSendMode] = useSettingMutable('messageSendMode');

    const options: Array<{ key: MessageSendMode; title: string; subtitle: string }> = [
        {
            key: 'agent_queue',
            title: 'Queue in agent (current)',
            subtitle: 'Write to transcript immediately; agent processes when ready.'
        },
        {
            key: 'interrupt',
            title: 'Interrupt & send',
            subtitle: 'Abort current turn, then send immediately.'
        },
        {
            key: 'server_pending',
            title: 'Pending until ready',
            subtitle: 'Keep messages in a pending queue; agent pulls when ready.'
        }
    ];

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Message sending"
                footer="Controls what happens when you send a message while the agent is running."
            >
                {options.map((option) => (
                    <Item
                        key={option.key}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={<Ionicons name="send-outline" size={29} color="#007AFF" />}
                        rightElement={
                            messageSendMode === option.key ? (
                                <Ionicons name="checkmark" size={20} color="#007AFF" />
                            ) : null
                        }
                        onPress={() => setMessageSendMode(option.key)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
}

