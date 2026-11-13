import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { DesktopDialogFrame } from '@/components/DesktopDialogFrame';
import { sync } from '@/sync/sync';
import { useSetting } from '@/sync/storage';
import { isPersonalAgentAvatar, personalAgentDisplayName, PERSONAL_AGENT_NAME_MAX_LENGTH } from '@/sync/personalAgent';
import { t } from '@/text';
import { PersonalAvatar } from './PersonalAvatar';

export function PersonalProfileDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const name = useSetting('personalAgentName');
    const avatar = useSetting('personalAgentAvatar');
    const [draftName, setDraftName] = React.useState(name);
    const [draftAvatar, setDraftAvatar] = React.useState(avatar);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(false);
    const generation = React.useRef(0);
    const { theme } = useUnistyles();
    React.useEffect(() => {
        if (visible) { setDraftName(name); setDraftAvatar(avatar); setError(false); setBusy(false); }
        generation.current++;
        return () => { generation.current++; };
    }, [visible]);
    const pickAvatar = async () => {
        const current = ++generation.current;
        setBusy(true); setError(false);
        try {
            if (Platform.OS !== 'web') {
                const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
                if (!permission.granted) return;
            }
            const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
            if (result.canceled || current !== generation.current) return;
            const asset = result.assets[0];
            const side = Math.min(asset.width, asset.height);
            const image = await ImageManipulator.manipulateAsync(asset.uri, [
                { crop: { originX: (asset.width - side) / 2, originY: (asset.height - side) / 2, width: side, height: side } },
                { resize: { width: 256, height: 256 } },
            ], { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true });
            const data = `data:image/jpeg;base64,${image.base64}`;
            if (!isPersonalAgentAvatar(data)) throw new Error('invalid-avatar');
            if (current === generation.current) setDraftAvatar(data);
        } catch { if (current === generation.current) setError(true); }
        finally { if (current === generation.current) setBusy(false); }
    };
    return <DesktopDialogFrame visible={visible} onClose={onClose} title={t('personalAgent.editProfile')} testID="personal-profile-dialog" maxWidth={420}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.avatar}><PersonalAvatar uri={draftAvatar} size={80} /></View>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void pickAvatar()} style={styles.action} testID="personal-profile-change-avatar">
                <Text style={styles.link}>{t('personalAgent.changeAvatar')}</Text>
            </Pressable>
            {draftAvatar && <Pressable accessibilityRole="button" disabled={busy} onPress={() => { generation.current++; setDraftAvatar(null); }} style={styles.action} testID="personal-profile-reset-avatar"><Text style={styles.secondary}>{t('personalAgent.resetAvatar')}</Text></Pressable>}
            {busy && <ActivityIndicator color={theme.colors.textSecondary} />}
            <Text style={styles.label}>{t('personalAgent.name')}</Text>
            <TextInput accessibilityLabel={t('personalAgent.name')} placeholder={t('personalAgent.namePlaceholder')} placeholderTextColor={theme.colors.textSecondary} value={draftName} onChangeText={setDraftName} maxLength={PERSONAL_AGENT_NAME_MAX_LENGTH} style={styles.input} testID="personal-profile-name" />
            {error && <Text accessibilityRole="alert" style={styles.error}>{t('personalAgent.profileSaveFailed')}</Text>}
            <View style={styles.buttons}>
                <Pressable accessibilityRole="button" onPress={onClose} style={styles.action}><Text style={styles.secondary}>{t('common.cancel')}</Text></Pressable>
                <Pressable accessibilityRole="button" disabled={busy || !draftName?.trim()} onPress={() => {
                    sync.applySettings({ personalAgentName: personalAgentDisplayName(draftName), personalAgentAvatar: draftAvatar });
                    onClose();
                }} style={({ pressed }) => [styles.save, pressed && styles.pressed, (busy || !draftName?.trim()) && styles.disabled]} testID="personal-profile-save"><Text style={styles.saveText}>{t('common.save')}</Text></Pressable>
            </View>
        </ScrollView>
    </DesktopDialogFrame>;
}

const styles = StyleSheet.create(theme => ({
    content: { padding: 24, gap: 8 },
    avatar: { alignSelf: 'center', marginBottom: 8 },
    action: { alignItems: 'center', padding: 10, borderRadius: 8 },
    link: { color: theme.colors.textLink, fontSize: 14 },
    secondary: { color: theme.colors.textSecondary, fontSize: 14 },
    label: { color: theme.colors.text, fontSize: 14, marginTop: 16 },
    input: { color: theme.colors.text, backgroundColor: theme.colors.input.background, borderRadius: 10, fontSize: 16, padding: 12 },
    buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 16 },
    save: { backgroundColor: theme.colors.button.primary.background, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
    saveText: { color: theme.colors.button.primary.tint, fontSize: 14 },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.45 },
    error: { color: theme.colors.textDestructive, fontSize: 13 },
}));
