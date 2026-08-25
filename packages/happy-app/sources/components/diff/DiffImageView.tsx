/**
 * Before/after view for image files.
 *
 * A binary diff has nothing to render as text, and "binary file not shown" is
 * the least useful thing to say about an icon that changed. When both sides
 * exist they sit next to each other at the same height so the difference is
 * visible at a glance; an added or deleted image shows the single side there is.
 */

import * as React from 'react';
import { Image } from 'expo-image';
import { Text, View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useDiffPalette } from './DiffPalette';

export interface DiffImageViewProps {
    /** data: URI of the version in HEAD, if the file existed there. */
    before?: string | null;
    /** data: URI of the version on disk, if the file still exists. */
    after?: string | null;
}

export const DiffImageView = React.memo(function DiffImageView({ before, after }: DiffImageViewProps) {
    const palette = useDiffPalette();

    if (!before && !after) {
        return (
            <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                <Text style={{ ...Typography.default(), fontSize: 13, color: palette.textSecondary }}>
                    {t('diff.binaryFile')}
                </Text>
            </View>
        );
    }

    return (
        <View style={{ flexDirection: 'row', padding: 12, gap: 12, backgroundColor: palette.surface }}>
            {before ? (
                <Pane uri={before} label={t('diff.imageBefore')} tint={palette.marker.del} palette={palette} />
            ) : null}
            {after ? (
                <Pane uri={after} label={t('diff.imageAfter')} tint={palette.marker.add} palette={palette} />
            ) : null}
        </View>
    );
});

const Pane = React.memo(function Pane({
    uri,
    label,
    tint,
    palette,
}: {
    uri: string;
    label: string;
    tint: string;
    palette: ReturnType<typeof useDiffPalette>;
}) {
    return (
        <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ ...Typography.mono('semiBold'), fontSize: 10.5, color: tint, textTransform: 'uppercase' }}>
                {label}
            </Text>
            <View
                style={{
                    borderWidth: 1,
                    borderColor: palette.divider,
                    borderRadius: 6,
                    overflow: 'hidden',
                    // A fixed height keeps the two sides comparable; `contain`
                    // means neither is cropped to achieve it.
                    height: 160,
                    backgroundColor: palette.hunkBg,
                }}
            >
                <Image
                    style={{ width: '100%', height: '100%' }}
                    source={{ uri }}
                    contentFit="contain"
                    transition={0}
                />
            </View>
        </View>
    );
});
