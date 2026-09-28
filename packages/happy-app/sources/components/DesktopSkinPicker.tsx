import * as React from 'react';
import { ImageBackground, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { DREAMSKIN_BACKGROUND_URL, type DesktopSkinId } from '@/desktopSkin';
import { t } from '@/text';

type Props = { value: DesktopSkinId; onChange: (id: DesktopSkinId) => void };

export function DesktopSkinPicker({ value, onChange }: Props) {
    return (
        <View style={styles.row} testID="desktop-skin-picker" {...({ role: 'radiogroup' } as any)}>
            <Pressable
                accessibilityRole="radio"
                accessibilityLabel={t('settingsAppearance.desktopSkinDefault')}
                accessibilityState={{ selected: value === 'default', checked: value === 'default' }}
                onPress={() => onChange('default')}
                style={({ pressed }) => [styles.option, value === 'default' && styles.selected, pressed && styles.pressed]}
                testID="desktop-skin-default"
            >
                <View style={[styles.preview, styles.defaultPreview]}>
                    <View style={styles.defaultPreviewSidebar} />
                    <View style={styles.defaultPreviewContent} />
                </View>
                <Text style={styles.title}>{t('settingsAppearance.desktopSkinDefault')}</Text>
                <Text style={styles.description}>{t('settingsAppearance.desktopSkinDefaultDescription')}</Text>
            </Pressable>
            <Pressable
                accessibilityRole="radio"
                accessibilityLabel={t('settingsAppearance.desktopSkinDreamskin')}
                accessibilityState={{ selected: value === 'dreamskin', checked: value === 'dreamskin' }}
                onPress={() => onChange('dreamskin')}
                style={({ pressed }) => [styles.option, value === 'dreamskin' && styles.selected, pressed && styles.pressed]}
                testID="desktop-skin-dreamskin"
            >
                <ImageBackground source={{ uri: DREAMSKIN_BACKGROUND_URL }} resizeMode="cover" style={styles.preview} imageStyle={styles.photo}>
                    <View style={styles.photoVeil} />
                    <View style={styles.photoPreviewSidebar} />
                    <View style={styles.photoPreviewContent} />
                </ImageBackground>
                <Text style={styles.title}>{t('settingsAppearance.desktopSkinDreamskin')}</Text>
                <Text style={styles.description}>{t('settingsAppearance.desktopSkinDreamskinDescription')}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
    option: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        borderWidth: 1,
        flexGrow: 1,
        minWidth: 160,
        padding: 9,
        width: 190,
    },
    selected: { backgroundColor: theme.colors.surfaceSelected, borderColor: theme.colors.accent },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    preview: { borderRadius: 8, height: 88, overflow: 'hidden', width: '100%' },
    defaultPreview: { backgroundColor: theme.colors.groupped.background, flexDirection: 'row' },
    defaultPreviewSidebar: { backgroundColor: theme.colors.surfaceHigh, width: 38 },
    defaultPreviewContent: { alignSelf: 'center', backgroundColor: theme.colors.surface, borderRadius: 5, height: 44, marginLeft: 15, width: 92 },
    photo: { borderRadius: 8 },
    photoVeil: { backgroundColor: 'rgba(15, 18, 22, 0.32)', bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
    photoPreviewSidebar: { backgroundColor: 'rgba(22, 25, 29, 0.82)', bottom: 0, left: 0, position: 'absolute', top: 0, width: 38 },
    photoPreviewContent: { alignSelf: 'center', backgroundColor: 'rgba(32, 36, 42, 0.78)', borderRadius: 5, height: 44, marginLeft: 54, width: 92 },
    title: { color: theme.colors.text, fontSize: 14, fontWeight: '600', marginTop: 8 },
    description: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16, marginTop: 3 },
}));
