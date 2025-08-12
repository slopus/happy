import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from '@expo/vector-icons';
import { parseToolUseError } from '@/utils/toolErrorParser';

export function ToolError(props: { message: string }) {
    const { isToolUseError, errorMessage } = parseToolUseError(props.message);
    const displayMessage = isToolUseError && errorMessage ? errorMessage : props.message;
    
    return (
        <View style={[styles.errorContainer, isToolUseError && styles.toolUseErrorContainer]}>
            {isToolUseError && (
                <Ionicons name="warning" size={16} color="#FF9500" />
            )}
            <Text style={[styles.errorText, isToolUseError && styles.toolUseErrorText]}>
                {displayMessage}
            </Text>
        </View>
    )
}

const styles = StyleSheet.create({
    errorContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        backgroundColor: '#FFF0F0',
        borderRadius: 6,
        padding: 12,
        borderWidth: 1,
        borderColor: '#FF3B30',
        marginBottom: 12,
        maxHeight: 115,
        overflow: 'hidden',
    },
    toolUseErrorContainer: {
        backgroundColor: '#FFF8F0',
        borderColor: '#FF9500',
    },
    errorText: {
        fontSize: 13,
        color: '#FF3B30',
        flex: 1,
    },
    toolUseErrorText: {
        color: '#FF9500',
    },
});