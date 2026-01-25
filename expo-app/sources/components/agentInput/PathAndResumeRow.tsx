import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { ResumeChip } from './ResumeChip';

export type PathAndResumeRowStyles = {
    pathRow: any;
    actionButtonsLeft: any;
    actionChip: any;
    actionChipIconOnly: any;
    actionChipPressed: any;
    actionChipText: any;
};

export type PathAndResumeRowProps = {
    styles: PathAndResumeRowStyles;
    showChipLabels: boolean;
    iconColor: string;
    currentPath?: string | null;
    onPathClick?: () => void;
    resumeSessionId?: string | null;
    onResumeClick?: () => void;
    resumeLabelTitle: string;
    resumeLabelOptional: string;
};

export function PathAndResumeRow(props: PathAndResumeRowProps) {
    const hasPath = Boolean(props.currentPath && props.onPathClick);
    const hasResume = Boolean(props.onResumeClick);
    if (!hasPath && !hasResume) return null;

    return (
        <View style={[props.styles.pathRow, { flex: 1, minWidth: 0 }]} testID="agentInput-pathResumeRow">
            <View style={[props.styles.actionButtonsLeft, { flex: 1, flexWrap: 'nowrap', minWidth: 0 }]}>
                {hasPath ? (
                    <Pressable
                        onPress={props.onPathClick}
                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                        style={(p) => ([
                            props.styles.actionChip,
                            p.pressed ? props.styles.actionChipPressed : null,
                            // Do not grow to fill the row; it should behave like other chips and stay left-aligned.
                            { flexShrink: 1, minWidth: 0 },
                        ])}
                    >
                        <Ionicons
                            name="folder-outline"
                            size={16}
                            color={props.iconColor}
                        />
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="middle"
                            style={[props.styles.actionChipText, { flexShrink: 1 }]}
                        >
                            {props.currentPath}
                        </Text>
                    </Pressable>
                ) : null}

                {hasResume ? (
                    <ResumeChip
                        onPress={props.onResumeClick!}
                        showLabel={props.showChipLabels}
                        resumeSessionId={props.resumeSessionId}
                        labelTitle={props.resumeLabelTitle}
                        labelOptional={props.resumeLabelOptional}
                        iconColor={props.iconColor}
                        pressableStyle={(pressed) => ([
                            props.styles.actionChip,
                            !props.showChipLabels ? props.styles.actionChipIconOnly : null,
                            pressed ? props.styles.actionChipPressed : null,
                            { flexShrink: 0 },
                        ])}
                        textStyle={props.styles.actionChipText}
                    />
                ) : null}
            </View>
        </View>
    );
}
