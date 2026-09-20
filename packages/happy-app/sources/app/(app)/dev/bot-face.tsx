import * as React from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { SvgXml } from 'react-native-svg';

import { ItemGroup } from '@/components/ItemGroup';
import { encodeBase64 } from '@/encryption/base64';
import { BOT_FACE_PAINT_SIZE, botFaceSvg } from '@/utils/botFace';
import { paintBotFace } from '@/utils/botFacePaint';

/*
 * The face the picker draws, next to the face a bot is actually given.
 *
 * Those are two different renderers: the picker draws the SVG with
 * react-native-svg, and the bot wears a PNG that Skia rasterised. They
 * disagreed once. Skia would not follow the `<use>` references DiceBear emits,
 * so it drew the background and dropped the eyes, brows and mouth — a bot in a
 * blank swatch, chosen from a picker that looked perfect. Nothing in the app
 * put the two side by side, so the difference only ever surfaced on a bot.
 *
 * The painted size is worth watching too: a face that is one flat colour
 * compresses to a few hundred bytes, while a drawn one runs to several
 * thousand. The number tells you which one you are looking at.
 */

const SEEDS = ['abc12345', 'zz990011', 'q7r4t2y8'] as const;
const PREVIEW = 96;

type Painted =
    | { readonly state: 'painting' }
    | { readonly state: 'painted'; readonly uri: string; readonly bytes: number }
    | { readonly state: 'failed'; readonly reason: string };

function usePaintedFace(seed: string): Painted {
    const [painted, setPainted] = React.useState<Painted>({ state: 'painting' });
    React.useEffect(() => {
        let watching = true;
        setPainted({ state: 'painting' });
        (async () => {
            try {
                const painting = await paintBotFace(seed);
                if (!watching) return;
                setPainted({
                    state: 'painted',
                    uri: `data:${painting.mimeType};base64,${encodeBase64(painting.bytes)}`,
                    bytes: painting.bytes.length,
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                if (watching) setPainted({ state: 'failed', reason });
            }
        })();
        return () => { watching = false; };
    }, [seed]);
    return painted;
}

function FaceRow({ seed }: { readonly seed: string }) {
    const svg = React.useMemo(() => botFaceSvg(seed, BOT_FACE_PAINT_SIZE), [seed]);
    const painted = usePaintedFace(seed);

    return (
        <View style={styles.row}>
            <View style={styles.face}>
                <View style={styles.frame} testID={`bot-face-picker-${seed}`}>
                    <SvgXml xml={svg} width="100%" height="100%" />
                </View>
                <Text style={styles.caption}>picker · svg</Text>
            </View>

            <View style={styles.face}>
                <View style={styles.frame} testID={`bot-face-painted-${seed}`}>
                    {painted.state === 'painting' && <ActivityIndicator />}
                    {painted.state === 'painted' && (
                        <Image source={{ uri: painted.uri }} style={styles.painted} />
                    )}
                    {painted.state === 'failed' && (
                        <Text style={styles.failure}>{painted.reason}</Text>
                    )}
                </View>
                <Text style={styles.caption}>
                    {painted.state === 'painted' ? `worn · ${painted.bytes} B` : 'worn · png'}
                </Text>
            </View>

            <Text style={styles.seed}>{seed}</Text>
        </View>
    );
}

export default function BotFaceScreen() {
    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Bot Faces' }} />
            <ScrollView style={styles.container} contentContainerStyle={styles.content}>
                <Text style={styles.description}>
                    Left is what the picker shows. Right is the PNG the bot is given. They
                    should be the same face — if the right one is a flat colour, the
                    rasteriser dropped the features.
                </Text>
                <ItemGroup title="Picked vs worn">
                    {SEEDS.map((seed) => <FaceRow key={seed} seed={seed} />)}
                </ItemGroup>
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    content: { padding: 16, gap: 12 },
    description: { fontSize: 13, lineHeight: 18, opacity: 0.7 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 12, paddingHorizontal: 4 },
    face: { alignItems: 'center', gap: 6 },
    frame: {
        width: PREVIEW,
        height: PREVIEW,
        borderRadius: PREVIEW / 2,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(127,127,127,0.12)',
    },
    painted: { width: '100%', height: '100%' },
    caption: { fontSize: 11, opacity: 0.6 },
    failure: { fontSize: 9, textAlign: 'center', paddingHorizontal: 4 },
    seed: { fontSize: 12, opacity: 0.5, fontVariant: ['tabular-nums'] },
});
