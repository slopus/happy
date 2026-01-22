import * as React from 'react';
import { View, Text, ViewStyle, TextStyle } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

interface ChatFooterProps {
    controlledByUser?: boolean;
}

export const ChatFooter = React.memo((props: ChatFooterProps) => {
    const { theme } = useUnistyles();
    const containerStyle: ViewStyle = {
        alignItems: 'center',
        paddingTop: 4,
        paddingBottom: 2,
    };
    const warningContainerStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 4,
        backgroundColor: theme.colors.box.warning.background,
        borderRadius: 8,
        marginHorizontal: 32,
        marginTop: 4,
    };
    const warningTextStyle: TextStyle = {
        fontSize: 12,
        color: theme.colors.box.warning.text,
        marginLeft: 6,
        ...Typography.default()
    };
    return (
        <View style={containerStyle}>
            {props.controlledByUser && (
                <View style={warningContainerStyle}>
                    <Ionicons 
                        name="information-circle" 
                        size={16} 
                        color={theme.colors.box.warning.text}
                    />
                    <Text style={warningTextStyle}>
                        Permissions shown in terminal only. Reset or send a message to control from app.
                    </Text>
                </View>
            )}
        </View>
    );
});