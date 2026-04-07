import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';

const PROVIDERS = [
    {
        key: 'elevenlabs' as const,
        title: 'ElevenLabs',
        subtitle: () => t('settingsVoice.backendElevenLabsSubtitle'),
    },
    {
        key: 'openai' as const,
        title: 'OpenAI GPT-4o',
        subtitle: () => t('settingsVoice.backendOpenAISubtitle'),
    },
];

export default function VoiceProviderScreen() {
    const router = useRouter();
    const [voiceBackend, setVoiceBackend] = useSettingMutable('voiceBackend');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsVoice.backendTitle')}
                footer={t('settingsVoice.backendDescription')}
            >
                {PROVIDERS.map((provider) => (
                    <Item
                        key={provider.key}
                        title={provider.title}
                        subtitle={provider.subtitle()}
                        icon={<Ionicons name="mic-outline" size={29} color="#007AFF" />}
                        rightElement={
                            voiceBackend === provider.key ? (
                                <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                            ) : null
                        }
                        onPress={() => {
                            setVoiceBackend(provider.key);
                            if (router.canGoBack()) {
                                router.back();
                            }
                        }}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
}
