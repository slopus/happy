import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import { DetectedClisModal } from '@/components/machines/DetectedClisModal';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { getAgentCore, getAgentCliGlyph } from '@/agents/catalog';
import { useEnabledAgentIds } from '@/agents/useEnabledAgentIds';
import type { CapabilityId } from '@/sync/capabilitiesProtocol';

type Props = {
    machineId: string;
    isOnline: boolean;
    /**
     * When true, the component may trigger capabilities detection fetches.
     * When false, it will render cached results only (no automatic fetching).
     */
    autoDetect?: boolean;
};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 6,
    },
    glyph: {
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    glyphMuted: {
        opacity: 0.35,
    },
}));

// iOS can render some dingbat glyphs as emoji; force text presentation (U+FE0E).
export const MachineCliGlyphs = React.memo(({ machineId, isOnline, autoDetect = true }: Props) => {
    useUnistyles(); // re-render on theme changes
    const styles = stylesheet;
    const enabledAgents = useEnabledAgentIds();

    const { state } = useMachineCapabilitiesCache({
        machineId,
        enabled: autoDetect && isOnline,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
    });

    const onPress = React.useCallback(() => {
        // Cache-first: opening this modal should NOT fetch by default.
        // Users can explicitly refresh inside the modal if needed.
        Modal.show({
            component: DetectedClisModal,
            props: {
                machineId,
                isOnline,
            },
        });
    }, [isOnline, machineId]);

    const glyphs = React.useMemo(() => {
        if (state.status !== 'loaded') {
            return [{ key: 'unknown', glyph: '•', factor: 0.85, muted: true }];
        }

        const items: Array<{ key: string; glyph: string; factor: number; muted: boolean }> = [];
        const results = state.snapshot.response.results;
        for (const agentId of enabledAgents) {
            const capId = `cli.${getAgentCore(agentId).cli.detectKey}` as CapabilityId;
            const available = (results[capId]?.ok && (results[capId].data as any)?.available === true) ?? false;
            if (!available) continue;
            const core = getAgentCore(agentId);
            items.push({
                key: agentId,
                glyph: getAgentCliGlyph(agentId),
                factor: core.ui.cliGlyphScale ?? 1.0,
                muted: false,
            });
        }

        if (items.length === 0) {
            items.push({ key: 'none', glyph: '•', factor: 0.85, muted: true });
        }

        return items;
    }, [enabledAgents, state]);

    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [
                styles.container,
                { opacity: !isOnline ? 0.5 : (pressed ? 0.7 : 1) },
            ]}
        >
            {glyphs.map((item) => (
                <Text
                    key={item.key}
                    style={[
                        styles.glyph,
                        item.muted ? styles.glyphMuted : null,
                        { fontSize: Math.round(14 * item.factor), lineHeight: 16 },
                    ]}
                >
                    {item.glyph}
                </Text>
            ))}
        </Pressable>
    );
});
