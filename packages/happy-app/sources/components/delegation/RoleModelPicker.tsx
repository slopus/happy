import * as React from 'react';
import { View, Text, Pressable, ScrollView, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SearchableListSelector, type SelectorConfig } from '@/components/SearchableListSelector';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type RoleModelOption = { code: string; value: string; supportedEffortLevels?: string[] };

/** A bounded, read-only choice surface; all configuration changes stay in the form. */
export const RoleModelPicker = React.memo(function RoleModelPicker({ models, selectedCode, onSelect, onDismiss, onClose }: {
    models: RoleModelOption[]; selectedCode: string; onSelect: (code: string) => void; onDismiss: () => void; onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const options = React.useMemo(() => [{ code: '', value: t('delegation.nativeDefault') }, ...models], [models]);
    React.useEffect(() => () => onDismiss(), [onDismiss]);
    const config = React.useMemo<SelectorConfig<RoleModelOption>>(() => ({
        getItemId: option => option.code,
        getItemTitle: option => option.value,
        getItemSubtitle: option => option.code || undefined,
        getItemIcon: () => null,
        formatForDisplay: option => option.value,
        parseFromDisplay: () => null,
        filterItem: (option, query) => `${option.value} ${option.code}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        searchPlaceholder: t('delegation.searchModels'), recentSectionTitle: t('delegation.model'), favoritesSectionTitle: '',
        noItemsMessage: t('projectGoals.noMatchingItems'), showFavorites: false, showRecent: false, allowCustomInput: false, compactItems: true, filterAllItems: true,
    }), []);
    return <View style={[styles.container, { width: Math.min(480, Math.max(260, width - 32)), maxHeight: Math.min(560, Math.max(160, height - 80)) }]} testID="delegation-model-picker">
        <View style={styles.heading}><Text style={styles.title}>{t('delegation.chooseModel')}</Text><Pressable onPress={onClose} accessibilityLabel={t('common.cancel')} accessibilityRole="button" style={styles.close} testID="delegation-model-picker-close"><Ionicons name="close-outline" size={22} color={theme.colors.text} /></Pressable></View>
        <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <SearchableListSelector config={config} items={options} selectedItem={options.find(option => option.code === selectedCode) ?? null}
                onSelect={option => { onSelect(option.code); onClose(); }} />
        </ScrollView>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    container: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 14, overflow: 'hidden' },
    heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.colors.divider, gap: 12 },
    title: { ...Typography.default('semiBold'), fontSize: 16, lineHeight: 23, color: theme.colors.text, flex: 1 },
    close: { minHeight: 40, minWidth: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
    scroll: { flexShrink: 1 },
    content: { paddingTop: 15, paddingBottom: 16 },
}));
