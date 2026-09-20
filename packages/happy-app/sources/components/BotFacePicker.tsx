import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SvgXml } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { botFaceCredit, botFaceSvg, type BotFaceSeeds, type BotFaceSlot } from '@/utils/botFace';
import { openExternalUrl } from '@/utils/openExternalUrl';

/**
 * The square each offered face fills at most. The four faces share the row's
 * width with the die and shrink together on a narrow phone, so the row never
 * runs past the screen: at 320dp they are about 36dp each.
 */
const FACE_SIZE = 52;
const FACE_RADIUS = 14;
const RING_WIDTH = 2;
const DIE_SIZE = 40;

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 6,
    },
    // Named the way the pickers name their sections, so the block reads as one
    // more setting rather than a row of pictures that arrived on its own.
    heading: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    faces: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    face: {
        flex: 1,
        maxWidth: FACE_SIZE,
        aspectRatio: 1,
        borderRadius: FACE_RADIUS,
        overflow: 'hidden',
        // The ring is always laid out, chosen or not, so picking a face moves
        // nothing: only the ring's colour changes.
        borderWidth: RING_WIDTH,
        borderColor: 'transparent',
    },
    facePicked: {
        borderColor: theme.colors.text,
    },
    faceImage: {
        flex: 1,
        borderRadius: FACE_RADIUS - RING_WIDTH,
        overflow: 'hidden',
    },
    // Right beside the faces, not off at the edge: rolling is what you do to
    // the four of them, so it reads as the fifth thing in the row.
    die: {
        width: DIE_SIZE,
        height: DIE_SIZE,
        flexShrink: 0,
        borderRadius: DIE_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    diePressed: {
        backgroundColor: theme.colors.glass.backgroundSubtle,
    },
    credit: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default(),
    },
    creditLink: {
        textDecorationLine: 'underline',
    },
}));

/**
 * The faces a new bot may wear: four drawn from seeds, one already picked, and
 * a die to roll four more. The artist is credited beneath, with a link to her
 * work, as the licence asks and as the desktop does.
 */
export const BotFacePicker = React.memo(({
    seeds,
    slot,
    onPick,
    onRoll,
}: {
    seeds: BotFaceSeeds;
    slot: BotFaceSlot;
    onPick: (slot: BotFaceSlot) => void;
    onRoll: () => void;
}) => {
    const { theme } = useUnistyles();
    const faces = React.useMemo(
        () => seeds.map((seed) => botFaceSvg(seed, FACE_SIZE)),
        [seeds],
    );
    return (
        <View style={styles.container}>
            <Text style={styles.heading}>Avatar</Text>
            <View style={styles.faces} accessibilityRole="radiogroup">
                {faces.map((svg, index) => {
                    const picked = index === slot;
                    return (
                        <Pressable
                            key={seeds[index]}
                            onPress={() => onPick(index as BotFaceSlot)}
                            style={[styles.face, picked && styles.facePicked]}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: picked }}
                            accessibilityLabel={`Face ${index + 1}`}
                        >
                            <View style={styles.faceImage}>
                                <SvgXml xml={svg} width="100%" height="100%" />
                            </View>
                        </Pressable>
                    );
                })}
                <Pressable
                    onPress={onRoll}
                    style={({ pressed }) => [styles.die, pressed && styles.diePressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Roll four new faces"
                >
                    <Ionicons name="dice-outline" size={22} color={theme.colors.text} />
                </Pressable>
            </View>
            <Text style={styles.credit} numberOfLines={1}>
                {'Art by '}
                <Text
                    style={styles.creditLink}
                    onPress={() => void openExternalUrl(botFaceCredit.artistUrl)}
                    accessibilityRole="link"
                >
                    {botFaceCredit.artist}
                </Text>
            </Text>
        </View>
    );
});
