import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DiffView } from '@/components/diff/DiffView';
import { Typography } from '@/constants/Typography';

export interface PierreDiffViewProps {
    oldFile?: { name: string; contents: string };
    newFile?: { name: string; contents: string };
    /** Unified diff string — alternative to oldFile/newFile. */
    patch?: string;
    diffStyle?: 'unified' | 'split';
    overflow?: 'scroll' | 'wrap';
    disableLineNumbers?: boolean;
    /** Forces a theme override; defaults to the current app theme. */
    theme?: 'dark' | 'light';
}

export const PierreDiffView = React.memo(function PierreDiffView(props: PierreDiffViewProps) {
    if (Platform.OS === 'web') {
        return <PierreDiffViewWeb {...props} />;
    }
    return <PierreDiffViewNative {...props} />;
});

// ────────────────────────────────────────────────────────────────────────────
// Web module loader. Both @pierre/diffs and @pierre/diffs/react are lazy
// chunks; we resolve them once per app run and memoize the promise so every
// diff mount after the first one gets a cache hit with no extra render cycle.
// ────────────────────────────────────────────────────────────────────────────

type PierreMain = typeof import('@pierre/diffs');
type PierreReact = typeof import('@pierre/diffs/react');
type PierreBundle = { main: PierreMain; react: PierreReact };

let pierreBundlePromise: Promise<PierreBundle> | null = null;

function loadPierre(): Promise<PierreBundle> {
    if (!pierreBundlePromise) {
        pierreBundlePromise = (async () => {
            // Side-effect import registers the <diffs-container> custom element.
            const main = await import('@pierre/diffs');
            const react = await import('@pierre/diffs/react');
            return { main, react };
        })();
    }
    return pierreBundlePromise;
}

/**
 * Fire-and-forget prefetch — call once when entering a screen that will show
 * diffs so the lazy chunks are already in cache by the time they're rendered.
 */
export function prefetchPierreDiff(): void {
    if (Platform.OS !== 'web') return;
    void loadPierre();
}

function usePierreBundle(): PierreBundle | null {
    const [bundle, setBundle] = React.useState<PierreBundle | null>(null);
    React.useEffect(() => {
        let cancelled = false;
        loadPierre().then((b) => { if (!cancelled) setBundle(b); });
        return () => { cancelled = true; };
    }, []);
    return bundle;
}

// ────────────────────────────────────────────────────────────────────────────
// Web rendering.
// ────────────────────────────────────────────────────────────────────────────

const PierreDiffViewWeb = React.memo(function PierreDiffViewWeb(props: PierreDiffViewProps) {
    const { theme } = useUnistyles();
    const themeName: 'dark' | 'light' = props.theme ?? (theme.dark ? 'dark' : 'light');
    const diffsTheme = themeName === 'dark' ? 'github-dark' : 'github-light';
    const bundle = usePierreBundle();

    if (!bundle) return <DiffSkeleton />;

    const options = {
        theme: diffsTheme as any,
        diffStyle: props.diffStyle,
        overflow: props.overflow,
        disableLineNumbers: props.disableLineNumbers,
    };

    if (props.patch) {
        return <PatchFilesWeb bundle={bundle} patch={props.patch} options={options} />;
    }

    if (props.oldFile && props.newFile) {
        return <FileDiffFromFiles bundle={bundle} oldFile={props.oldFile} newFile={props.newFile} options={options} />;
    }

    return <View />;
});

function PatchFilesWeb({
    bundle,
    patch,
    options,
}: {
    bundle: PierreBundle;
    patch: string;
    options: any;
}) {
    const files = React.useMemo(() => {
        try {
            const parsed = bundle.main.processPatch(patch);
            return parsed.files ?? [];
        } catch {
            return [];
        }
    }, [bundle, patch]);

    const { FileDiff } = bundle.react;
    return (
        <View>
            {files.map((fileDiff, i) => (
                <FileDiff key={i} fileDiff={fileDiff} options={options} />
            ))}
        </View>
    );
}

function FileDiffFromFiles({
    bundle,
    oldFile,
    newFile,
    options,
}: {
    bundle: PierreBundle;
    oldFile: { name: string; contents: string };
    newFile: { name: string; contents: string };
    options: any;
}) {
    const fileDiff = React.useMemo(
        () => bundle.main.parseDiffFromFile(oldFile, newFile),
        [bundle, oldFile, newFile],
    );
    const { FileDiff } = bundle.react;
    return <FileDiff fileDiff={fileDiff} options={options} />;
}

function DiffSkeleton() {
    const { theme } = useUnistyles();
    return (
        <View
            style={{
                height: 96,
                backgroundColor: theme.colors.surface,
                borderRadius: 6,
                opacity: 0.5,
            }}
        />
    );
}

// ────────────────────────────────────────────────────────────────────────────
// Native: no network dependencies. For oldFile/newFile we route to the classic
// plain-text DiffView; for a raw patch string we colorize lines by prefix.
// Always unified on native — `diffStyle` is intentionally ignored.
// ────────────────────────────────────────────────────────────────────────────

const PierreDiffViewNative = React.memo(function PierreDiffViewNative(props: PierreDiffViewProps) {
    if (props.patch) {
        return <PlainPatchView patch={props.patch} wrapLines={props.overflow === 'wrap'} />;
    }
    if (props.oldFile && props.newFile) {
        return (
            <DiffView
                oldText={props.oldFile.contents}
                newText={props.newFile.contents}
                showLineNumbers={!props.disableLineNumbers}
                wrapLines={props.overflow === 'wrap'}
            />
        );
    }
    return <View />;
});

function PlainPatchView({ patch, wrapLines }: { patch: string; wrapLines: boolean }) {
    const { theme } = useUnistyles();
    const colors = theme.colors.diff;

    const lines = React.useMemo(() => patch.split('\n'), [patch]);

    return (
        <View style={{ backgroundColor: theme.colors.surface, flex: 1, overflow: 'hidden' }}>
            {lines.map((line, i) => {
                const first = line.charAt(0);
                const isFileHeader =
                    line.startsWith('+++') ||
                    line.startsWith('---') ||
                    line.startsWith('diff ') ||
                    line.startsWith('index ') ||
                    line.startsWith('new file') ||
                    line.startsWith('deleted file') ||
                    line.startsWith('rename ') ||
                    line.startsWith('similarity ') ||
                    line.startsWith('Binary files');
                const isHunkHeader = line.startsWith('@@');

                let bg: string = colors.contextBg;
                let fg: string = colors.contextText;

                if (isHunkHeader) {
                    bg = colors.hunkHeaderBg;
                    fg = colors.hunkHeaderText;
                } else if (isFileHeader) {
                    bg = colors.contextBg;
                    fg = colors.hunkHeaderText;
                } else if (first === '+') {
                    bg = colors.addedBg;
                    fg = colors.addedText;
                } else if (first === '-') {
                    bg = colors.removedBg;
                    fg = colors.removedText;
                }

                return (
                    <Text
                        key={i}
                        numberOfLines={wrapLines ? undefined : 1}
                        style={{
                            ...Typography.mono(),
                            fontSize: 13,
                            lineHeight: 20,
                            backgroundColor: bg,
                            color: fg,
                            paddingHorizontal: 8,
                        }}
                    >
                        {line.length === 0 ? ' ' : line}
                    </Text>
                );
            })}
        </View>
    );
}
