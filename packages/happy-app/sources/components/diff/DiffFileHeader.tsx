/** Shared file header: icon, path, change badge, +/- counts, collapse chevron. */

import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FileIcon } from '@/components/FileIcon';
import { Typography } from '@/constants/Typography';
import { useDiffPalette } from './DiffPalette';
import type { FileChangeKind } from './engine/types';

/** Everything the header needs — a built `DiffFile` satisfies it, and so does a git-status entry. */
export interface DiffFileSummary {
    path: string;
    kind: FileChangeKind;
    additions: number;
    deletions: number;
}

export interface DiffFileHeaderProps {
    file: DiffFileSummary;
    collapsed?: boolean;
    onToggle?: () => void;
    /** Shown instead of the full path when set. */
    title?: string;
    right?: React.ReactNode;
}

export const DiffFileHeader = React.memo(function DiffFileHeader({
    file,
    collapsed,
    onToggle,
    title,
    right,
}: DiffFileHeaderProps) {
    const palette = useDiffPalette();
    const fileName = file.path.split('/').pop() || file.path;
    const dir = file.path.slice(0, file.path.length - fileName.length);

    const content = (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 12,
                paddingVertical: 9,
                backgroundColor: palette.hunkBg,
                borderBottomWidth: 1,
                borderBottomColor: palette.divider,
            }}
        >
            {onToggle ? (
                <Ionicons
                    name={collapsed ? 'chevron-forward' : 'chevron-down'}
                    size={14}
                    color={palette.textSecondary}
                />
            ) : null}
            <FileIcon fileName={fileName} size={16} />
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'baseline' }}>
                <Text numberOfLines={1} ellipsizeMode="head" style={{ ...Typography.mono(), fontSize: 12, color: palette.textSecondary, flexShrink: 1 }}>
                    {title ?? dir}
                </Text>
                {title ? null : (
                    <Text numberOfLines={1} style={{ ...Typography.mono('semiBold'), fontSize: 12.5, color: palette.text }}>
                        {fileName}
                    </Text>
                )}
            </View>
            {file.kind === 'added' ? <Badge text="new" color={palette.marker.add} /> : null}
            {file.kind === 'deleted' ? <Badge text="deleted" color={palette.marker.del} /> : null}
            {file.kind === 'renamed' ? <Badge text="renamed" color={palette.textSecondary} /> : null}
            {file.additions > 0 ? (
                <Text style={{ ...Typography.mono(), fontSize: 12, color: palette.marker.add }}>{`+${file.additions}`}</Text>
            ) : null}
            {file.deletions > 0 ? (
                <Text style={{ ...Typography.mono(), fontSize: 12, color: palette.marker.del }}>{`−${file.deletions}`}</Text>
            ) : null}
            {right}
        </View>
    );

    if (!onToggle) return content;
    return <Pressable onPress={onToggle}>{content}</Pressable>;
});

const Badge = React.memo(function Badge({ text, color }: { text: string; color: string }) {
    return (
        <Text style={{ ...Typography.mono('semiBold'), fontSize: 10.5, color, textTransform: 'uppercase' }}>
            {text}
        </Text>
    );
});
