import { StyleSheet, Text, View } from "react-native";

export function ToolError(props: { message: string }) {
    return (
        <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{props.message}</Text>
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
    errorText: {
        fontSize: 13,
        color: '#FF3B30',
        flex: 1,
    },
});