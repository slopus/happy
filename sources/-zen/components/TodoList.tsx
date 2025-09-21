import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    useDerivedValue,
    SharedValue,
    runOnJS,
    runOnUI,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { TODO_HEIGHT, TodoView } from './TodoView';

export type TodoListProps = {
    todos: { id: string, value: string, done: boolean }[];
    onToggleTodo?: (id: string) => void;
}

type AnimatedTodoItemProps = {
    todo: { id: string, value: string, done: boolean };
    index: number;
    positions: SharedValue<Record<string, number>>;
    scrollY: SharedValue<number>;
    onToggle?: () => void;
}

const ITEM_SPACING = 12;

function getPosition(index: number) {
    'worklet';
    return index * TODO_HEIGHT + index * ITEM_SPACING;
}

function getOrder(y: number) {
    'worklet';
    return Math.round(y / (TODO_HEIGHT + ITEM_SPACING));
}

const AnimatedTodoItem = React.memo<AnimatedTodoItemProps>(({
    todo,
    index,
    positions,
    scrollY,
    onToggle
}) => {
    const isDragging = useSharedValue(false);
    const dragY = useSharedValue(0);
    const scale = useSharedValue(1);
    const opacity = useSharedValue(1);
    const zIndex = useSharedValue(0);
    const startDragY = useSharedValue(0);
    const hasDragged = useSharedValue(false);

    // Derive the current position from the shared positions object
    const position = useDerivedValue(() => {
        return positions.value[todo.id] ?? index;
    });

    const translateY = useDerivedValue(() => {
        if (isDragging.value) {
            return dragY.value;
        }
        return withSpring(getPosition(position.value));
    });

    const panGesture = Gesture.Pan()
        .activateAfterLongPress(500)
        .onStart((e) => {
            'worklet';
            isDragging.value = true;
            hasDragged.value = true;
            const currentPos = getPosition(position.value);
            // Store where we started dragging from
            startDragY.value = currentPos;
            // Keep the item at its current position initially (no jump)
            dragY.value = currentPos;
            scale.value = withSpring(1.1);
            opacity.value = withSpring(0.5);
            zIndex.value = 1000;
        })
        .onUpdate((e) => {
            'worklet';
            // Move based on translation from where we started
            dragY.value = startDragY.value + e.translationY;
            
            // Calculate which position we're over based on current drag position
            const newOrder = getOrder(dragY.value);
            const currentOrder = position.value;
            
            // Get the total number of items
            const totalItems = Object.keys(positions.value).length;
            
            // If we've moved to a new position, update all positions
            if (newOrder !== currentOrder && newOrder >= 0 && newOrder < totalItems) {
                const newPositions = Object.assign({}, positions.value);
                
                // Shift all items between old and new position
                for (const key in newPositions) {
                    const pos = newPositions[key];
                    if (newOrder > currentOrder) {
                        // Moving down
                        if (pos > currentOrder && pos <= newOrder) {
                            newPositions[key] = pos - 1;
                        }
                    } else {
                        // Moving up
                        if (pos < currentOrder && pos >= newOrder) {
                            newPositions[key] = pos + 1;
                        }
                    }
                }
                
                // Set the dragged item to new position
                newPositions[todo.id] = newOrder;
                positions.value = newPositions;
            }
        })
        .onEnd(() => {
            'worklet';
            isDragging.value = false;
            scale.value = withSpring(1);
            opacity.value = withSpring(1);
            zIndex.value = withSpring(0);
        })
        .onFinalize(() => {
            'worklet';
            isDragging.value = false;
            scale.value = withSpring(1);
            opacity.value = withSpring(1);
            zIndex.value = withSpring(0);
            // Keep the hasDragged flag true for a moment to block the press
            if (hasDragged.value) {
                runOnJS(() => {
                    setTimeout(() => {
                        'worklet';
                        runOnUI(() => {
                            hasDragged.value = false;
                        })();
                    }, 200);
                })();
            }
        });

    const animatedStyle = useAnimatedStyle(() => {
        return {
            transform: [
                { translateY: translateY.value },
                { scale: scale.value },
            ],
            opacity: opacity.value,
            zIndex: zIndex.value,
        };
    });

    return (
        <GestureDetector gesture={panGesture}>
            <Animated.View
                style={[
                    {
                        position: 'absolute',
                        top: 0,
                        left: 8,
                        right: 8,
                    },
                    animatedStyle,
                ]}
            >
                <TodoView
                    id={todo.id}
                    done={todo.done}
                    value={todo.value}
                    onToggle={onToggle}
                    hasDragged={hasDragged}
                />
            </Animated.View>
        </GestureDetector>
    );
});

export const TodoList = React.memo<TodoListProps>((props) => {
    const positions = useSharedValue<Record<string, number>>({});
    const scrollY = useSharedValue(0);

    // Initialize positions
    React.useEffect(() => {
        const newPositions: Record<string, number> = {};
        props.todos.forEach((todo, index) => {
            newPositions[todo.id] = index;
        });
        positions.value = newPositions;
    }, [props.todos]);

    return (
        <View style={{ 
            height: TODO_HEIGHT * props.todos.length + ITEM_SPACING * (props.todos.length - 1), 
            position: 'relative' 
        }}>
            {props.todos.map((todo, index) => (
                <AnimatedTodoItem
                    key={todo.id}
                    todo={todo}
                    index={index}
                    positions={positions}
                    scrollY={scrollY}
                    onToggle={() => props.onToggleTodo?.(todo.id)}
                />
            ))}
        </View>
    );
});