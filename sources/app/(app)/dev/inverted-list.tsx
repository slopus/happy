import React, { useState } from 'react';
import { View, Text, FlatList, TextInput, KeyboardAvoidingView, Platform, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { useKeyboardHandler, useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { runOnJS, useSharedValue } from 'react-native-reanimated';
import { FlashList } from '@shopify/flash-list';
import { LegendList } from '@legendapp/list';

type ListType = 'flash' | 'flat' | 'legend';
type PaddingType = 'animated' | 'non-animated' | 'header-footer';

export default function InvertedListTest() {
    const [messages, setMessages] = useState<Array<{ id: string; text: string }>>([]);
    const [inputText, setInputText] = useState('');
    const [listType, setListType] = useState<ListType>('flash');
    const [paddingType, setPaddingType] = useState<PaddingType>('non-animated');
    const insets = useSafeAreaInsets();
    const { height, progress } = useReanimatedKeyboardAnimation();
    const [paddingValue, setPaddingValue] = useState(0);
    const animatedPaddingValue = useSharedValue(0);

    useKeyboardHandler({
        onStart(e) {
            'worklet';
            runOnJS(setPaddingValue)(e.height);
            if (paddingType === 'animated') {
                animatedPaddingValue.value = e.height;
            }
        },
        onEnd(e) {
            'worklet';
            runOnJS(setPaddingValue)(e.height);
            if (paddingType === 'animated') {
                animatedPaddingValue.value = e.height;
            }
        },
    })

    const addMessage = () => {
        if (inputText.trim()) {
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                text: inputText
            }]);
            setInputText('');
        }
    };

    const renderItem = ({ item }: { item: { id: string; text: string } }) => (
        <View style={styles.messageItem}>
            <Text style={styles.messageText}>{item.text}</Text>
        </View>
    );

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: 'Inverted List Test',
                }}
            />

            <Animated.View style={[styles.container, { transform: [{ translateY: height }] }]}>
                <View style={styles.controlsContainer}>
                    <View>
                        <Text style={styles.controlLabel}>List Implementation:</Text>
                        <View style={styles.buttonRow}>
                            <TouchableOpacity
                                onPress={() => setListType('flash')}
                                style={[styles.button, listType === 'flash' ? styles.buttonActive : styles.buttonInactive]}
                            >
                                <Text style={[styles.buttonText, listType === 'flash' ? styles.buttonTextActive : styles.buttonTextInactive]}>FlashList</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={() => setListType('flat')}
                                style={[styles.button, listType === 'flat' ? styles.buttonActive : styles.buttonInactive]}
                            >
                                <Text style={[styles.buttonText, listType === 'flat' ? styles.buttonTextActive : styles.buttonTextInactive]}>FlatList</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={() => setListType('legend')}
                                style={[styles.button, listType === 'legend' ? styles.buttonActive : styles.buttonInactive]}
                            >
                                <Text style={[styles.buttonText, listType === 'legend' ? styles.buttonTextActive : styles.buttonTextInactive]}>LegendList</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                    <View>
                        <Text style={styles.controlLabel}>Padding Method:</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                            <View style={styles.buttonRow}>
                                <TouchableOpacity
                                    onPress={() => setPaddingType('animated')}
                                    style={[styles.button, paddingType === 'animated' ? styles.buttonActive : styles.buttonInactive]}
                                >
                                    <Text style={[styles.buttonText, paddingType === 'animated' ? styles.buttonTextActive : styles.buttonTextInactive]}>Animated</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={() => setPaddingType('non-animated')}
                                    style={[styles.button, paddingType === 'non-animated' ? styles.buttonActive : styles.buttonInactive]}
                                >
                                    <Text style={[styles.buttonText, paddingType === 'non-animated' ? styles.buttonTextActive : styles.buttonTextInactive]}>Non-Animated</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={() => setPaddingType('header-footer')}
                                    style={[styles.button, paddingType === 'header-footer' ? styles.buttonActive : styles.buttonInactive]}
                                >
                                    <Text style={[styles.buttonText, paddingType === 'header-footer' ? styles.buttonTextActive : styles.buttonTextInactive]}>Header/Footer</Text>
                                </TouchableOpacity>
                            </View>
                        </ScrollView>
                    </View>
                </View>
                
                {(() => {
                    const ListEmptyComponent = (
                        <View style={styles.emptyState}>
                            <Text style={styles.emptyStateText}>
                                No messages yet. Type something below!
                            </Text>
                        </View>
                    );
                    
                    const ListHeaderComponent = paddingType === 'header-footer' ? 
                        <View style={{ height: paddingValue }} /> : undefined;
                    
                    const ListContainer = paddingType === 'animated' ? Animated.View : View;
                    const containerStyle = { 
                        flex: 1, 
                        paddingTop: paddingType === 'non-animated' ? paddingValue : 
                                    paddingType === 'animated' ? animatedPaddingValue : 0
                    };
                    
                    if (listType === 'flash') {
                        return (
                            <ListContainer style={containerStyle as any}>
                                <FlashList
                                    data={messages}
                                    renderItem={renderItem}
                                    keyExtractor={item => item.id}
                                    maintainVisibleContentPosition={{
                                        autoscrollToBottomThreshold: 0.2,
                                        autoscrollToTopThreshold: 100,
                                        startRenderingFromBottom: true
                                    }}
                                    ListEmptyComponent={ListEmptyComponent}
                                    ListHeaderComponent={ListHeaderComponent}
                                />
                            </ListContainer>
                        );
                    } else if (listType === 'flat') {
                        return (
                            <ListContainer style={containerStyle as any}>
                                <FlatList
                                    data={[...messages].reverse()}
                                    renderItem={renderItem}
                                    keyExtractor={item => item.id}
                                    maintainVisibleContentPosition={{
                                        minIndexForVisible: 0,
                                        autoscrollToTopThreshold: 100,
                                    }}
                                    inverted={true}
                                    ListEmptyComponent={ListEmptyComponent}
                                    ListHeaderComponent={ListHeaderComponent}
                                />
                            </ListContainer>
                        );
                    } else {
                        return (
                            <ListContainer style={containerStyle as any}>
                                <LegendList
                                    data={messages}
                                    renderItem={renderItem}
                                    keyExtractor={item => item.id}
                                    maintainVisibleContentPosition={true}
                                    maintainScrollAtEnd={true}
                                    ListEmptyComponent={ListEmptyComponent}
                                    ListHeaderComponent={ListHeaderComponent}
                                />
                            </ListContainer>
                        );
                    }
                })()}

                <View style={[styles.inputContainer, { paddingBottom: insets.bottom + 4 }]}>
                    <View style={styles.inputRow}>
                        <TextInput
                            style={styles.textInput}
                            placeholder="Type a message..."
                            value={inputText}
                            onChangeText={setInputText}
                            onSubmitEditing={addMessage}
                            returnKeyType="send"
                        />
                        <TouchableOpacity
                            onPress={addMessage}
                            style={styles.sendButton}
                        >
                            <Text style={styles.sendButtonText}>Send</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Animated.View>
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'white',
    },
    controlsContainer: {
        backgroundColor: '#f3f4f6',
        padding: 8,
        gap: 8,
    },
    controlLabel: {
        fontSize: 12,
        fontWeight: '600',
        marginBottom: 4,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 8,
    },
    button: {
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 4,
    },
    buttonActive: {
        backgroundColor: '#3b82f6',
    },
    buttonInactive: {
        backgroundColor: '#d1d5db',
    },
    buttonText: {
        fontSize: 12,
    },
    buttonTextActive: {
        color: 'white',
    },
    buttonTextInactive: {
        color: '#374151',
    },
    messageItem: {
        padding: 16,
        marginHorizontal: 16,
        marginVertical: 8,
        backgroundColor: '#f3f4f6',
        borderRadius: 8,
    },
    messageText: {
        color: '#1f2937',
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
    },
    emptyStateText: {
        color: '#6b7280',
        textAlign: 'center',
    },
    inputContainer: {
        borderTopWidth: 1,
        borderTopColor: '#e5e7eb',
        padding: 16,
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    textInput: {
        flex: 1,
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: '#f3f4f6',
        borderRadius: 20,
        marginRight: 8,
    },
    sendButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: '#3b82f6',
        borderRadius: 20,
    },
    sendButtonText: {
        color: 'white',
        fontWeight: '600',
    },
});