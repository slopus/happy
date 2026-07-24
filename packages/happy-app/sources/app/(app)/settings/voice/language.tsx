import React, { useState, useMemo } from 'react';
import { Platform, View, TextInput, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';
import { LANGUAGES, getLanguageDisplayName, type Language } from '@/constants/Languages';
import { t } from '@/text';
import { MobileGlassSurface } from '@/components/MobileGlass';

export default function LanguageSelectionScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [voiceAssistantLanguage, setVoiceAssistantLanguage] = useSettingMutable('voiceAssistantLanguage');
    const [searchQuery, setSearchQuery] = useState('');

    // Filter languages based on search query
    const filteredLanguages = useMemo(() => {
        if (!searchQuery) return LANGUAGES;
        
        const query = searchQuery.toLowerCase();
        return LANGUAGES.filter(lang => 
            lang.name.toLowerCase().includes(query) ||
            lang.nativeName.toLowerCase().includes(query) ||
            (lang.code && lang.code.toLowerCase().includes(query)) ||
            (lang.region && lang.region.toLowerCase().includes(query))
        );
    }, [searchQuery]);


    const handleLanguageSelect = (languageCode: string | null) => {
        setVoiceAssistantLanguage(languageCode);
        router.back();
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Search Header */}
            <View style={{
                backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: Platform.select({ web: 1, default: 0 }),
                borderBottomColor: theme.colors.divider,
            }}>
                <MobileGlassSurface enabled={Platform.OS !== 'web'} interactive intensity={70} style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: Platform.select({ web: theme.colors.input.background, android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
                    borderRadius: 16,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    overflow: 'hidden',
                    borderWidth: Platform.OS === 'web' ? 0 : 0.5,
                    borderColor: theme.colors.glass.border,
                }}>
                    <Ionicons 
                        name="search-outline" 
                        size={20} 
                        color={theme.colors.textSecondary} 
                        style={{ marginRight: 8 }}
                    />
                    <TextInput
                        style={{
                            flex: 1,
                            fontSize: 16,
                            color: theme.colors.input.text,
                        }}
                        placeholder={t('settingsVoice.language.searchPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    {searchQuery.length > 0 && (
                        <Ionicons 
                            name="close-circle" 
                            size={20} 
                            color={theme.colors.textSecondary}
                            onPress={() => setSearchQuery('')}
                            style={{ marginLeft: 8 }}
                        />
                    )}
                </MobileGlassSurface>
            </View>

            {/* Language List */}
            <ItemGroup 
                title={t('settingsVoice.language.title')} 
                footer={t('settingsVoice.language.footer', { count: filteredLanguages.length })}
            >
                <FlatList
                    data={filteredLanguages}
                    keyExtractor={(item) => item.code || 'autodetect'}
                    renderItem={({ item }) => (
                        <Item
                            title={getLanguageDisplayName(item)}
                            subtitle={item.code || t('settingsVoice.language.autoDetect')}
                            icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                            rightElement={
                                voiceAssistantLanguage === item.code ? (
                                    <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                                ) : null
                            }
                            onPress={() => handleLanguageSelect(item.code)}
                            showChevron={false}
                        />
                    )}
                    scrollEnabled={false}
                />
            </ItemGroup>
        </ItemList>
    );
}
