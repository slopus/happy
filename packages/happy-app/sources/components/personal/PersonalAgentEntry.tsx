import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { useSetting } from '@/sync/storage';
import { personalAgentDisplayName } from '@/sync/personalAgent';
import { t } from '@/text';
import { PersonalAvatar } from './PersonalAvatar';
import { PersonalProfileDialog } from './PersonalProfileDialog';

export function PersonalAgentEntry({ onNavigate }: { onNavigate?: () => void } = {}) {
    const name = personalAgentDisplayName(useSetting('personalAgentName'));
    const avatar = useSetting('personalAgentAvatar');
    const pathname = usePathname();
    const router = useRouter();
    const selected = pathname === '/personal';
    const [editing, setEditing] = React.useState(false);
    const { theme } = useUnistyles();
    return <>
        <View style={[styles.row, selected && styles.selected]} testID="personal-agent-entry-row">
            <Pressable accessibilityRole="button" accessibilityLabel={name} accessibilityState={{ selected }} onPress={() => { if (!selected) router.navigate('/personal'); onNavigate?.(); }} testID="personal-agent-entry" style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
                <PersonalAvatar uri={avatar} size={28} />
                <Text numberOfLines={1} style={styles.name}>{name}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('personalAgent.editProfile')} onPress={() => setEditing(true)} style={({ pressed }) => [styles.edit, pressed && styles.pressed]} testID="personal-agent-edit-profile">
                <Feather name="more-horizontal" color={theme.colors.textSecondary} size={17} />
            </Pressable>
        </View>
        {editing && <PersonalProfileDialog visible onClose={() => setEditing(false)} />}
    </>;
}

const styles = StyleSheet.create(theme => ({
    row: { flexDirection: 'row', alignItems: 'center', borderRadius: 9, marginHorizontal: 10, marginTop: 4, marginBottom: 8, minHeight: 44 },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, minHeight: 44, borderRadius: 9 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    name: { flex: 1, color: theme.colors.text, fontSize: 14, fontWeight: '600' },
    edit: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, marginRight: 4 },
}));
