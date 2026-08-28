/**
 * Diff renderer benchmark.
 *
 * Dev-only page (no i18n) used to catch renderer regressions before they ship:
 * build cost, mount cost, and how many frames the UI and JS threads drop while
 * you fling through the result.
 *
 * Numbers are only meaningful on a real device in a release build — Metro's dev
 * bundle and the JS debugger both distort them badly.
 */

import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { DiffFileView } from '@/components/diff/DiffFileView';
import { DiffFilesList } from '@/components/diff/DiffFilesList';
import { DiffFileHeader } from '@/components/diff/DiffFileHeader';
import { buildDiffFromPatch, clearDiffCache } from '@/components/diff/engine/buildDiff';
import type { DiffDocument } from '@/components/diff/engine/types';
import { generateFiles, generatePatch } from '@/components/diff/fixtures';
import { countPatchStats } from '@/components/diff/engine/stats';
import type { DiffFileItem } from '@/components/diff/DiffFilesList';

type Preset = { label: string; files: number; lines: number };

const PRESETS: Preset[] = [
    { label: 'chat edit', files: 1, lines: 40 },
    { label: 'file', files: 1, lines: 400 },
    { label: 'big file', files: 1, lines: 4000 },
    { label: 'PR', files: 12, lines: 300 },
    { label: 'huge PR', files: 60, lines: 600 },
];

type Mode = 'chat' | 'file' | 'pr';

export default function DiffBenchScreen() {
    const { theme } = useUnistyles();
    const [preset, setPreset] = React.useState(0);
    const [mode, setMode] = React.useState<Mode>('file');
    const [syntax, setSyntax] = React.useState(true);
    const [intraline, setIntraline] = React.useState(true);
    const [wrap, setWrap] = React.useState(false);
    const [split, setSplit] = React.useState(false);
    const [run, setRun] = React.useState(0);

    const [patch, setPatch] = React.useState('');
    const [genMs, setGenMs] = React.useState(0);
    const [doc, setDoc] = React.useState<DiffDocument | null>(null);
    const [mountMs, setMountMs] = React.useState<number | null>(null);
    const mountStart = React.useRef(0);

    // Fixture generation is itself expensive at the big presets, so it's timed
    // separately and never counted against the renderer.
    React.useEffect(() => {
        const { files, lines } = PRESETS[preset];
        const t0 = performance.now();
        const generated = generatePatch(files, lines);
        setGenMs(performance.now() - t0);
        setPatch(generated);
    }, [preset]);

    // Bumped on every rebuild so the content subtree is thrown away and
    // remounted — otherwise React reuses it and there is no mount to measure.
    const [contentKey, setContentKey] = React.useState(0);

    React.useEffect(() => {
        if (!patch) return;
        clearDiffCache();
        setMountMs(null);
        const built = buildDiffFromPatch(patch, { syntax, intraline });
        mountStart.current = performance.now();
        setDoc(built);
        setContentKey((k) => k + 1);
    }, [patch, syntax, intraline, mode, wrap, split, run]);

    const onContentLaidOut = React.useCallback(() => {
        if (mountStart.current === 0) return;
        setMountMs(performance.now() - mountStart.current);
        mountStart.current = 0;
    }, []);

    const rowCount = React.useMemo(
        () => (doc ? doc.files.reduce((n, f) => n + f.rows.length, 0) : 0),
        [doc],
    );

    // The PR list builds each file as its section scrolls in, so it takes the
    // per-file patches rather than the document we built for the other modes.
    const prItems = React.useMemo<DiffFileItem[]>(() => {
        const { files, lines } = PRESETS[preset];
        return generateFiles(files, lines).map((f) => ({
            path: f.path,
            kind: 'modified' as const,
            ...countPatchStats(f.patch),
            source: { kind: 'patch' as const, patch: f.patch },
        }));
    }, [preset]);

    const frames = useFrameStats();

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            <View style={{ padding: 12, gap: 8, backgroundColor: theme.colors.surface }}>
                <Row label="preset">
                    {PRESETS.map((p, i) => (
                        <Chip key={p.label} label={p.label} active={preset === i} onPress={() => setPreset(i)} />
                    ))}
                </Row>
                <Row label="mode">
                    {(['chat', 'file', 'pr'] as Mode[]).map((m) => (
                        <Chip key={m} label={m} active={mode === m} onPress={() => setMode(m)} />
                    ))}
                </Row>
                <Row label="renderer">
                    <Chip label="syntax" active={syntax} onPress={() => setSyntax((v) => !v)} />
                    <Chip label="words" active={intraline} onPress={() => setIntraline((v) => !v)} />
                    <Chip label="wrap" active={wrap} onPress={() => setWrap((v) => !v)} />
                    <Chip label="split" active={split} onPress={() => setSplit((v) => !v)} />
                    <Chip label="rerun" active={false} onPress={() => setRun((v) => v + 1)} />
                </Row>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                    <Stat label="files" value={doc ? String(doc.files.length) : '—'} />
                    <Stat label="rows" value={String(rowCount)} />
                    <Stat label="gen" value={`${genMs.toFixed(0)}ms`} />
                    <Stat label="build" value={doc ? `${doc.buildMs.toFixed(1)}ms` : '—'} />
                    <Stat label="mount" value={mountMs === null ? '…' : `${mountMs.toFixed(0)}ms`} />
                    <Stat label="js fps" value={frames.jsFps.toFixed(0)} />
                    <Stat label="ui fps" value={frames.uiFps.toFixed(0)} />
                    <Stat label="worst" value={`${frames.worstMs.toFixed(0)}ms`} />
                </View>
            </View>

            <View key={contentKey} style={{ flex: 1 }} onLayout={onContentLaidOut}>
                {!doc ? null : mode === 'pr' ? (
                    <DiffFilesList items={prItems} wrap={wrap} split={split} autoCollapseAbove={100000} />
                ) : (
                    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
                        {mode === 'chat' ? (
                            <ChatSimulation doc={doc} wrap={wrap} split={split} />
                        ) : (
                            doc.files.map((file, i) => (
                                <View key={`${file.path}:${i}`} style={{ marginBottom: 12 }}>
                                    <DiffFileHeader file={file} />
                                    <DiffFileView file={file} wrap={wrap} split={split} collapseAfter={100000} />
                                </View>
                            ))
                        )}
                    </ScrollView>
                )}
            </View>
        </View>
    );
}

/**
 * Approximates the chat: diffs interleaved with message-sized blocks, so the
 * measurement includes the cost of living inside someone else's scroll view.
 */
const ChatSimulation = React.memo(function ChatSimulation({
    doc,
    wrap,
    split,
}: {
    doc: DiffDocument;
    wrap: boolean;
    split: boolean;
}) {
    const { theme } = useUnistyles();
    const blocks = React.useMemo(() => {
        const out: DiffDocument['files'] = [];
        // Repeat the fixture so even the small preset produces a long thread.
        for (let i = 0; i < 12; i++) out.push(...doc.files);
        return out;
    }, [doc]);

    return (
        <View style={{ padding: 12, gap: 12 }}>
            {blocks.map((file, i) => (
                <View key={i} style={{ gap: 8 }}>
                    <Text style={{ ...Typography.default(), color: theme.colors.text }}>
                        {`Updating ${file.path} (${i + 1})`}
                    </Text>
                    <View style={{ borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.divider }}>
                        <DiffFileView file={file} wrap={wrap} split={split} collapseAfter={60} showHunkHeaders />
                    </View>
                </View>
            ))}
        </View>
    );
});

/**
 * Samples both threads: `requestAnimationFrame` for JS and Reanimated's frame
 * callback for UI. A renderer can look fine on one and terrible on the other,
 * and on native it's usually the JS thread that dies first.
 */
function useFrameStats() {
    const [stats, setStats] = React.useState({ jsFps: 0, uiFps: 0, worstMs: 0 });

    const uiFrames = useSharedValue(0);
    useFrameCallback(() => {
        'worklet';
        uiFrames.value += 1;
    }, true);

    React.useEffect(() => {
        let raf = 0;
        let last = performance.now();
        let jsFrames = 0;
        let worst = 0;
        let windowStart = last;
        let uiAtWindowStart = uiFrames.value;

        const tick = () => {
            const now = performance.now();
            const delta = now - last;
            last = now;
            jsFrames++;
            if (delta > worst) worst = delta;

            if (now - windowStart >= 500) {
                const seconds = (now - windowStart) / 1000;
                const uiNow = uiFrames.value;
                setStats({
                    jsFps: jsFrames / seconds,
                    uiFps: (uiNow - uiAtWindowStart) / seconds,
                    worstMs: worst,
                });
                jsFrames = 0;
                worst = 0;
                windowStart = now;
                uiAtWindowStart = uiNow;
            }
            raf = requestAnimationFrame(tick);
        };

        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [uiFrames]);

    return stats;
}

// ────────────────────────────────────────────────────────────────────────────
// Small dev-only controls
// ────────────────────────────────────────────────────────────────────────────

const Row = React.memo(function Row({ label, children }: { label: string; children: React.ReactNode }) {
    const { theme } = useUnistyles();
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={{ ...Typography.mono(), fontSize: 11, width: 62, color: theme.colors.textSecondary }}>{label}</Text>
            {children}
        </View>
    );
});

const Chip = React.memo(function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={onPress}
            style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 14,
                backgroundColor: active ? theme.colors.text : theme.colors.groupped.background,
            }}
        >
            <Text style={{ ...Typography.default(), fontSize: 12, color: active ? theme.colors.surface : theme.colors.textSecondary }}>
                {label}
            </Text>
        </Pressable>
    );
});

const Stat = React.memo(function Stat({ label, value }: { label: string; value: string }) {
    const { theme } = useUnistyles();
    return (
        <View>
            <Text style={{ ...Typography.mono(), fontSize: 10, color: theme.colors.textSecondary }}>{label}</Text>
            <Text style={{ ...Typography.mono('semiBold'), fontSize: 14, color: theme.colors.text }}>{value}</Text>
        </View>
    );
});
