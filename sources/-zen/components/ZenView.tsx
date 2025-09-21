import * as React from 'react';
import { View, Text, ScrollView, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export const ZenView = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams();

    // Get todo data from params
    const todoId = params.id as string;
    const todoValue = params.value as string;
    const todoDone = params.done === 'true';

    const [isEditing, setIsEditing] = React.useState(false);
    const [editedText, setEditedText] = React.useState(todoValue);
    const [isDone, setIsDone] = React.useState(todoDone);

    const handleSave = () => {
        if (editedText.trim() && editedText !== todoValue) {
            // Update todo via global function
            if ((global as any).updateZenTodo) {
                (global as any).updateZenTodo(todoId, editedText.trim());
            }
        }
        setIsEditing(false);
    };

    const toggleDone = () => {
        const newDoneState = !isDone;
        setIsDone(newDoneState);
        // Update todo done status via global function
        if ((global as any).toggleZenTodo) {
            (global as any).toggleZenTodo(todoId);
        }
    };

    const handleDelete = () => {
        // Delete todo via global function
        if ((global as any).deleteZenTodo) {
            (global as any).deleteZenTodo(todoId);
        }
        router.back();
    };

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.container}
        >
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ flexGrow: 1 }}
                keyboardShouldPersistTaps="handled"
            >
                <View style={[
                    styles.content,
                    { paddingBottom: insets.bottom + 20 }
                ]}>
                    {/* Checkbox and Main Content */}
                    <View style={styles.mainSection}>
                        <Pressable
                            onPress={toggleDone}
                            style={[
                                styles.checkbox,
                                {
                                    borderColor: isDone ? theme.colors.success : theme.colors.textSecondary,
                                    backgroundColor: isDone ? theme.colors.success : 'transparent',
                                }
                            ]}
                        >
                            {isDone && (
                                <Ionicons name="checkmark" size={20} color="#FFFFFF" />
                            )}
                        </Pressable>

                        <View style={{ flex: 1 }}>
                            {isEditing ? (
                                <TextInput
                                    style={[
                                        styles.input,
                                        {
                                            color: theme.colors.text,
                                            borderBottomColor: theme.colors.divider,
                                        }
                                    ]}
                                    value={editedText}
                                    onChangeText={setEditedText}
                                    onBlur={handleSave}
                                    onSubmitEditing={handleSave}
                                    autoFocus
                                    multiline
                                    blurOnSubmit={true}
                                />
                            ) : (
                                <Pressable onPress={() => setIsEditing(true)}>
                                    <Text style={[
                                        styles.taskText,
                                        {
                                            color: isDone ? theme.colors.textSecondary : theme.colors.text,
                                            textDecorationLine: isDone ? 'line-through' : 'none',
                                            opacity: isDone ? 0.6 : 1,
                                        }
                                    ]}>
                                        {editedText}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    </View>

                    {/* Actions */}
                    <View style={styles.actions}>
                        <Pressable
                            onPress={handleDelete}
                            style={[styles.actionButton, { backgroundColor: theme.colors.textDestructive }]}
                        >
                            <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
                            <Text style={styles.actionButtonText}>Delete</Text>
                        </Pressable>
                    </View>

                    {/* Helper Text */}
                    <View style={styles.helperSection}>
                        <Text style={[styles.helperText, { color: theme.colors.textSecondary }]}>
                            Tap the task text to edit
                        </Text>
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    content: {
        flex: 1,
        padding: 20,
    },
    mainSection: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 32,
    },
    checkbox: {
        width: 28,
        height: 28,
        borderRadius: 14,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 16,
        marginTop: 4,
    },
    taskText: {
        fontSize: 20,
        lineHeight: 28,
        ...Typography.default(),
    },
    input: {
        fontSize: 20,
        lineHeight: 28,
        borderBottomWidth: 1,
        paddingVertical: 8,
        paddingHorizontal: 4,
        minHeight: 60,
        ...Typography.default(),
    },
    actions: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 24,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        gap: 8,
    },
    actionButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '500',
        ...Typography.default(),
    },
    helperSection: {
        marginTop: 32,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    helperText: {
        fontSize: 14,
        ...Typography.default(),
    },
}));