import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Text, View, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { SharedValue, useAnimatedReaction, runOnJS } from 'react-native-reanimated';

export const TODO_HEIGHT = 56;

export type TodoViewProps = {
    id: string;
    done: boolean;
    value: string;
    onToggle?: () => void;
    hasDragged?: SharedValue<boolean>;
}

export const TodoView = React.memo<TodoViewProps>((props) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [blockPress, setBlockPress] = React.useState(false);

    // Monitor hasDragged to block press events after drag
    useAnimatedReaction(
        () => props.hasDragged?.value ?? false,
        (hasDragged) => {
            runOnJS(setBlockPress)(hasDragged);
        },
        [props.hasDragged]
    );

    const handlePress = () => {
        // Don't open modal if we just finished dragging
        if (blockPress) {
            setBlockPress(false);
            return;
        }

        router.push({
            pathname: '/zen/view',
            params: {
                id: props.id,
                value: props.value,
                done: props.done.toString()
            }
        });
    };

    return (
        <Pressable onPress={handlePress} style={{
            height: TODO_HEIGHT,
            width: '100%',
            borderRadius: 8,
            backgroundColor: theme.colors.surfaceHighest,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12
        }}>
            <Pressable
                onPress={(e) => {
                    e.stopPropagation();
                    props.onToggle?.();
                }}
                hitSlop={8}
                style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: props.done ? theme.colors.success : theme.colors.textSecondary,
                    backgroundColor: props.done ? theme.colors.success : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12
                }}
            >
                {props.done && (
                    <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                )}
            </Pressable>
            <View style={{ flex: 1, flexDirection: 'row' }}>
                <Text
                    style={{
                        paddingLeft: 4,
                        paddingRight: 4,
                        paddingTop: 0,
                        paddingBottom: 0,
                        alignSelf: 'center',
                        color: props.done ? theme.colors.textSecondary : theme.colors.text,
                        fontSize: 18,
                        flexGrow: 1,
                        textDecorationLine: props.done ? 'line-through' : 'none',
                        opacity: props.done ? 0.6 : 1
                    }}
                    numberOfLines={1}
                >
                    {props.value}
                </Text>
            </View>
            {Platform.OS === 'web' && (
                <View
                    style={{
                        width: 48,
                        alignSelf: 'stretch',
                        borderRadius: 4,
                        opacity: 0.5,
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                >
                    <MaterialCommunityIcons name="drag" size={24} color={theme.colors.text} />
                </View>
            )}
        </Pressable>
    );
});