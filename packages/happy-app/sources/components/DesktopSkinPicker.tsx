import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PHOTO_DESKTOP_SKINS, desktopSkinBackgroundPosition, type DesktopSkinId } from '@/desktopSkin';
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
            {PHOTO_DESKTOP_SKINS.map((skin) => {
                const title = skin.id === 'dreamskin' ? t('settingsAppearance.desktopSkinDreamskin')
                    : skin.id === 'warmNight' ? t('settingsAppearance.desktopSkinWarmNight') : skin.name;
                const description = skin.id === 'dreamskin' ? t('settingsAppearance.desktopSkinDreamskinDescription')
                    : skin.id === 'warmNight' ? t('settingsAppearance.desktopSkinWarmNightDescription')
                        : t(skin.appearance === 'light' ? 'settingsAppearance.desktopSkinLightDescription' : 'settingsAppearance.desktopSkinDarkDescription');
                return (
                    <Pressable
                        key={skin.id}
                        accessibilityRole="radio"
                        accessibilityLabel={title}
                        accessibilityState={{ selected: value === skin.id, checked: value === skin.id }}
                        onPress={() => onChange(skin.id)}
                        style={({ pressed }) => [styles.option, value === skin.id && styles.selected, pressed && styles.pressed]}
                        testID={`desktop-skin-${skin.assetId}`}
                    >
                        <View style={[styles.preview, { backgroundImage: `url("${skin.backgroundUrl}")`,
                            backgroundSize: 'cover', backgroundPosition: desktopSkinBackgroundPosition(skin.id), backgroundRepeat: 'no-repeat' } as any]}>
                            <View style={[styles.photoVeil, { backgroundImage: skin.photoScrim } as any]} />
                            <View style={[styles.photoSidebar, { backgroundColor: skin.desktopSkin.sidebar }]} />
                            <View style={[styles.photoContent, { backgroundColor: skin.desktopSkin.readingCompact }]} />
                        </View>
                        <Text style={styles.title}>{title}</Text>
                        <Text style={styles.description}>{description}{'publisher' in skin ? ` · ${skin.publisher}` : ''}</Text>
                    </Pressable>
                );
            })}
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
    photoVeil: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
    photoSidebar: { bottom: 0, left: 0, position: 'absolute', top: 0, width: 38 },
    photoContent: { alignSelf: 'center', borderRadius: 5, height: 44, marginLeft: 54, width: 92 },
    title: { color: theme.colors.text, fontSize: 14, fontWeight: '600', marginTop: 8 },
    description: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16, marginTop: 3 },
}));
