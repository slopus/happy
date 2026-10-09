import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';

export default React.memo(function AppConversationsScreen() {
    return <View style={styles.root}><Text style={styles.hint}>{t('appConversations.selectConversation')}</Text></View>;
});
const styles = StyleSheet.create(theme => ({
    root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: theme.colors.groupped.background },
    hint: { color: theme.colors.textSecondary, fontSize: 16 },
}));
