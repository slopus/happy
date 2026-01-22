import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useSetting } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import { DetectedClisModal } from '@/components/machine/DetectedClisModal';

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
const CLAUDE_GLYPH = '\u2733\uFE0E';
const CODEX_GLYPH = '꩜';
const GEMINI_GLYPH = '\u2726\uFE0E';

export const MachineCliGlyphs = React.memo(({ machineId, isOnline, autoDetect = true }: Props) => {
    useUnistyles(); // re-render on theme changes
    const styles = stylesheet;
    const experimentsEnabled = useSetting('experiments');
    const expGemini = useSetting('expGemini');
    const allowGemini = experimentsEnabled && expGemini;

    const { state } = useMachineCapabilitiesCache({
        machineId,
        enabled: autoDetect && isOnline,
        request: { checklistId: 'new-session' },
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
        const hasClaude = (results['cli.claude']?.ok && (results['cli.claude'].data as any)?.available === true) ?? false;
        const hasCodex = (results['cli.codex']?.ok && (results['cli.codex'].data as any)?.available === true) ?? false;
        const hasGemini = allowGemini && ((results['cli.gemini']?.ok && (results['cli.gemini'].data as any)?.available === true) ?? false);

        if (hasClaude) items.push({ key: 'claude', glyph: CLAUDE_GLYPH, factor: 1.0, muted: false });
        if (hasCodex) items.push({ key: 'codex', glyph: CODEX_GLYPH, factor: 0.92, muted: false });
        if (hasGemini) items.push({ key: 'gemini', glyph: GEMINI_GLYPH, factor: 1.0, muted: false });

        if (items.length === 0) {
            items.push({ key: 'none', glyph: '•', factor: 0.85, muted: true });
        }

        return items;
    }, [allowGemini, state]);

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
