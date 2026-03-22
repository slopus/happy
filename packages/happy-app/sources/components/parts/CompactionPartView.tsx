import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { type v3 } from '@slopus/happy-sync';
import { t } from '@/text';

export const CompactionPartView = React.memo((_props: {
    part: v3.CompactionPart;
}) => {
    return (
        <View style={styles.container}>
            <Text style={styles.text}>{t('message.compactionMarker')}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 8,
        alignItems: 'center',
        paddingVertical: 8,
    },
    text: {
        color: theme.colors.agentEventText,
        fontSize: 14,
    },
}));
