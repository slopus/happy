import React from 'react';
import { View, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

// Placeholder — will be replaced with the session composer
export default React.memo(function NewSessionScreen() {
    const { theme } = useUnistyles();

    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.surface }}>
            <Text style={[Typography.default(), { fontSize: 16, color: theme.colors.textSecondary }]}>
                Coming soon
            </Text>
        </View>
    );
});
