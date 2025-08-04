import * as React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { MultiTextInput, KeyPressEvent } from '@/components/MultiTextInput';
import { Typography } from '@/constants/Typography';

export default function MultiTextInputDemo() {
    const [text1, setText1] = React.useState('');
    const [text2, setText2] = React.useState('This is some initial text that demonstrates how the component handles existing content.');
    const [text3, setText3] = React.useState('');
    const [text4, setText4] = React.useState('');
    const [text5, setText5] = React.useState('');
    const [lastKey, setLastKey] = React.useState<string>('');

    return (
        <ScrollView style={{ flex: 1, backgroundColor: 'white' }}>
            <View style={{ padding: 16, gap: 24 }}>
                <View>
                    <Text style={{ 
                        fontSize: 16, 
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        Basic Usage
                    </Text>
                    <Text style={{ 
                        fontSize: 14, 
                        color: '#666',
                        marginBottom: 12,
                        ...Typography.default()
                    }}>
                        Standard multi-line text input with default max height (120px)
                    </Text>
                    <View style={{
                        backgroundColor: '#f5f5f5',
                        borderRadius: 8,
                        padding: 12,
                    }}>
                        <MultiTextInput
                            value={text1}
                            onChangeText={setText1}
                            placeholder="Type something here..."
                        />
                    </View>
                    <Text style={{ 
                        fontSize: 12, 
                        color: '#999',
                        marginTop: 4,
                        ...Typography.default()
                    }}>
                        Characters: {text1.length}
                    </Text>
                </View>

                <View>
                    <Text style={{ 
                        fontSize: 16, 
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        With Initial Value
                    </Text>
                    <Text style={{ 
                        fontSize: 14, 
                        color: '#666',
                        marginBottom: 12,
                        ...Typography.default()
                    }}>
                        Pre-populated with text
                    </Text>
                    <View style={{
                        backgroundColor: '#f0f7ff',
                        borderRadius: 8,
                        padding: 12,
                    }}>
                        <MultiTextInput
                            value={text2}
                            onChangeText={setText2}
                            placeholder="This won't show because there's already text"
                        />
                    </View>
                    <Text style={{ 
                        fontSize: 12, 
                        color: '#999',
                        marginTop: 4,
                        ...Typography.default()
                    }}>
                        Characters: {text2.length}
                    </Text>
                </View>

                <View>
                    <Text style={{ 
                        fontSize: 16, 
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        Limited Height (60px)
                    </Text>
                    <Text style={{ 
                        fontSize: 14, 
                        color: '#666',
                        marginBottom: 12,
                        ...Typography.default()
                    }}>
                        This input has a lower max height, so it will scroll sooner
                    </Text>
                    <View style={{
                        backgroundColor: '#fff5f5',
                        borderRadius: 8,
                        padding: 12,
                    }}>
                        <MultiTextInput
                            value={text3}
                            onChangeText={setText3}
                            placeholder="Type multiple lines to see scrolling..."
                            maxHeight={60}
                        />
                    </View>
                    <Text style={{ 
                        fontSize: 12, 
                        color: '#999',
                        marginTop: 4,
                        ...Typography.default()
                    }}>
                        Characters: {text3.length} | Max height: 60px
                    </Text>
                </View>

                <View>
                    <Text style={{ 
                        fontSize: 16, 
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                    Larger Height (200px)
                    </Text>
                    <Text style={{ 
                        fontSize: 14, 
                        color: '#666',
                        marginBottom: 12,
                        ...Typography.default()
                    }}>
                        This input can grow much taller before scrolling
                    </Text>
                    <View style={{
                        backgroundColor: '#f5fff5',
                        borderRadius: 8,
                        padding: 12,
                    }}>
                        <MultiTextInput
                            value={text4}
                            onChangeText={setText4}
                            placeholder="You can write a lot more here before it starts scrolling..."
                            maxHeight={200}
                        />
                    </View>
                    <Text style={{ 
                        fontSize: 12, 
                        color: '#999',
                        marginTop: 4,
                        ...Typography.default()
                    }}>
                        Characters: {text4.length} | Max height: 200px
                    </Text>
                </View>

                <View>
                    <Text style={{ 
                        fontSize: 16, 
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        With Keyboard Handling
                    </Text>
                    <Text style={{ 
                        fontSize: 14, 
                        color: '#666',
                        marginBottom: 12,
                        ...Typography.default()
                    }}>
                        Press Enter to submit (clears the field), Escape to clear, or use arrow keys
                    </Text>
                    <View style={{
                        backgroundColor: '#fff0f5',
                        borderRadius: 8,
                        padding: 12,
                    }}>
                        <MultiTextInput
                            value={text5}
                            onChangeText={setText5}
                            placeholder="Try pressing Enter, Escape, or arrow keys..."
                            onKeyPress={(event: KeyPressEvent): boolean => {
                                setLastKey(`${event.key}${event.shiftKey ? ' + Shift' : ''}`);
                                
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    if (text5.trim()) {
                                        // Simulate submit
                                        setText5('');
                                        return true;
                                    }
                                } else if (event.key === 'Escape') {
                                    setText5('');
                                    return true;
                                }
                                
                                return false; // Let arrow keys and other keys work normally
                            }}
                        />
                    </View>
                    <Text style={{ 
                        fontSize: 12, 
                        color: '#999',
                        marginTop: 4,
                        ...Typography.default()
                    }}>
                        Last key pressed: {lastKey || 'None'} | Characters: {text5.length}
                    </Text>
                </View>

                <View style={{ height: 100 }} />
            </View>
        </ScrollView>
    );
}