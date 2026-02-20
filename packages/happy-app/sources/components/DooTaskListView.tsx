import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.groupped.background,
    },
    text: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export const DooTaskListView = React.memo(() => {
    return (
        <View style={styles.container}>
            <Text style={styles.text}>{t('dootask.title')}</Text>
        </View>
    );
});
