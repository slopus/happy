import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import type { DelegationRole } from '@slopus/happy-wire';
import { CodingAgentIcon } from '@/components/codingAgents/CodingAgentIcon';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type Props = { role: DelegationRole; machineId?: string; readOnly: boolean };

/** Compact receipt in the ordinary tool transcript; it never mutates a role. */
export const AgentRoleResultView = React.memo(function AgentRoleResultView({ role, machineId, readOnly }: Props) {
    const router = useRouter();
    const [focused, setFocused] = React.useState(false);
    const canNavigate = !readOnly && typeof machineId === 'string' && machineId.trim().length > 0;
    return <View style={styles.result} testID="agent-role-result">
        <View style={styles.heading}>
            <CodingAgentIcon agent={role.agent} size={24} />
            <View style={styles.titleCopy}>
                <Text style={styles.title} numberOfLines={2}>{role.name}</Text>
                <Text style={styles.meta} numberOfLines={2}>{role.agent === 'codex' ? 'Codex' : 'Antigravity'} · {role.model ?? t('delegation.nativeDefault')}</Text>
            </View>
        </View>
        <Text selectable style={styles.meta}>{t('delegation.roleId')} · {role.id}</Text>
        {canNavigate ? <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('delegation.viewRole')}
            testID="agent-role-view"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPress={event => {
                event.stopPropagation();
                router.push({ pathname: '/settings/delegation-roles', params: { machineId, roleId: role.id } });
            }}
            style={(state: { pressed: boolean; hovered?: boolean }) => [styles.action,
                (state.pressed || state.hovered) && styles.pressed, focused && styles.focused]}
        ><Text style={styles.actionText}>{t('delegation.viewRole')}</Text></Pressable> : null}
    </View>;
});

const styles = StyleSheet.create(theme => ({
    result: { gap: 10, paddingBottom: 12 },
    heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    titleCopy: { flex: 1, minWidth: 0, gap: 2 },
    title: { ...Typography.default('semiBold'), fontSize: 14, lineHeight: 20, color: theme.colors.text },
    meta: { ...Typography.default('regular'), fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary },
    action: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 40, paddingHorizontal: 12,
        paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface },
    actionText: { ...Typography.default('semiBold'), fontSize: 13, lineHeight: 18, color: theme.colors.text },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
}));
