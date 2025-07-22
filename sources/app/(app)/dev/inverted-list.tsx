import React, { useState } from 'react';
import { View, Text, FlatList, TextInput, KeyboardAvoidingView, Platform, TouchableOpacity, ScrollView } from 'react-native';
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
        <View className="p-4 mx-4 my-2 bg-gray-100 rounded-lg">
            <Text className="text-gray-800">{item.text}</Text>
        </View>
    );

    return (
        <>
            <Stack.Screen
                options={{
                    headerTitle: 'Inverted List Test',
                }}
            />

            <Animated.View className="flex-1 bg-white" style={{ transform: [{ translateY: height }] }}>
                <View className="bg-gray-100 p-2 space-y-2">
                    <View>
                        <Text className="text-xs font-semibold mb-1">List Implementation:</Text>
                        <View className="flex-row space-x-2">
                            <TouchableOpacity
                                onPress={() => setListType('flash')}
                                className={`px-3 py-1 rounded ${listType === 'flash' ? 'bg-blue-500' : 'bg-gray-300'}`}
                            >
                                <Text className={`text-xs ${listType === 'flash' ? 'text-white' : 'text-gray-700'}`}>FlashList</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={() => setListType('flat')}
                                className={`px-3 py-1 rounded ${listType === 'flat' ? 'bg-blue-500' : 'bg-gray-300'}`}
                            >
                                <Text className={`text-xs ${listType === 'flat' ? 'text-white' : 'text-gray-700'}`}>FlatList</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={() => setListType('legend')}
                                className={`px-3 py-1 rounded ${listType === 'legend' ? 'bg-blue-500' : 'bg-gray-300'}`}
                            >
                                <Text className={`text-xs ${listType === 'legend' ? 'text-white' : 'text-gray-700'}`}>LegendList</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                    <View>
                        <Text className="text-xs font-semibold mb-1">Padding Method:</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                            <View className="flex-row space-x-2">
                                <TouchableOpacity
                                    onPress={() => setPaddingType('animated')}
                                    className={`px-3 py-1 rounded ${paddingType === 'animated' ? 'bg-blue-500' : 'bg-gray-300'}`}
                                >
                                    <Text className={`text-xs ${paddingType === 'animated' ? 'text-white' : 'text-gray-700'}`}>Animated</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={() => setPaddingType('non-animated')}
                                    className={`px-3 py-1 rounded ${paddingType === 'non-animated' ? 'bg-blue-500' : 'bg-gray-300'}`}
                                >
                                    <Text className={`text-xs ${paddingType === 'non-animated' ? 'text-white' : 'text-gray-700'}`}>Non-Animated</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={() => setPaddingType('header-footer')}
                                    className={`px-3 py-1 rounded ${paddingType === 'header-footer' ? 'bg-blue-500' : 'bg-gray-300'}`}
                                >
                                    <Text className={`text-xs ${paddingType === 'header-footer' ? 'text-white' : 'text-gray-700'}`}>Header/Footer</Text>
                                </TouchableOpacity>
                            </View>
                        </ScrollView>
                    </View>
                </View>
                
                {(() => {
                    const ListEmptyComponent = (
                        <View className="flex-1 items-center justify-center p-8">
                            <Text className="text-gray-500 text-center">
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

                <View className="border-t border-gray-200 p-4" style={{ paddingBottom: insets.bottom + 4 }}>
                    <View className="flex-row items-center">
                        <TextInput
                            className="flex-1 px-4 py-2 bg-gray-100 rounded-full mr-2"
                            placeholder="Type a message..."
                            value={inputText}
                            onChangeText={setInputText}
                            onSubmitEditing={addMessage}
                            returnKeyType="send"
                        />
                        <TouchableOpacity
                            onPress={addMessage}
                            className="px-4 py-2 bg-blue-500 rounded-full"
                        >
                            <Text className="text-white font-semibold">Send</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Animated.View>
        </>
    );
}