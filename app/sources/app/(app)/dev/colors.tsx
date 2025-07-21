import * as React from 'react';
import { ScrollView, View, Text } from 'react-native';
import { Typography } from '@/constants/Typography';

const ColorSwatch = ({ name, color, textColor = '#000' }: { name: string; color: string; textColor?: string }) => (
    <View className="mb-4">
        <View 
            className="rounded-lg p-4 mb-2"
            style={{ backgroundColor: color }}
        >
            <Text style={{ color: textColor, ...Typography.default('semiBold') }}>{name}</Text>
            <Text style={{ color: textColor, ...Typography.mono(), fontSize: 12 }}>{color}</Text>
        </View>
    </View>
);

const ColorPair = ({ name, bg, text }: { name: string; bg: string; text: string }) => (
    <View className="mb-4">
        <View 
            className="rounded-lg p-4"
            style={{ backgroundColor: bg }}
        >
            <Text style={{ color: text, ...Typography.default('semiBold'), marginBottom: 4 }}>{name}</Text>
            <Text style={{ color: text, ...Typography.mono(), fontSize: 12 }}>BG: {bg}</Text>
            <Text style={{ color: text, ...Typography.mono(), fontSize: 12 }}>Text: {text}</Text>
        </View>
    </View>
);

export default function ColorsScreen() {
    return (
        <ScrollView className="flex-1 bg-white">
            <View className="p-4">
                {/* iOS System Colors */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4" style={Typography.default('semiBold')}>
                        iOS System Colors
                    </Text>
                    
                    <ColorSwatch name="Blue (Default Tint)" color="#007AFF" textColor="#FFF" />
                    <ColorSwatch name="Green (Success)" color="#34C759" textColor="#FFF" />
                    <ColorSwatch name="Orange (Warning)" color="#FF9500" textColor="#FFF" />
                    <ColorSwatch name="Red (Destructive)" color="#FF3B30" textColor="#FFF" />
                    <ColorSwatch name="Purple" color="#AF52DE" textColor="#FFF" />
                    <ColorSwatch name="Pink" color="#FF2D55" textColor="#FFF" />
                    <ColorSwatch name="Indigo" color="#5856D6" textColor="#FFF" />
                    <ColorSwatch name="Teal" color="#5AC8FA" textColor="#FFF" />
                    <ColorSwatch name="Yellow" color="#FFCC00" textColor="#000" />
                </View>

                {/* Gray Scale */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4" style={Typography.default('semiBold')}>
                        Gray Scale
                    </Text>
                    
                    <ColorSwatch name="Label" color="#000000" textColor="#FFF" />
                    <ColorSwatch name="Secondary Label" color="#3C3C43" textColor="#FFF" />
                    <ColorSwatch name="Tertiary Label" color="#3C3C43" textColor="#FFF" />
                    <ColorSwatch name="Quaternary Label" color="#3C3C43" textColor="#FFF" />
                    <ColorSwatch name="Placeholder Text" color="#C7C7CC" />
                    <ColorSwatch name="Separator" color="#C6C6C8" />
                    <ColorSwatch name="Opaque Separator" color="#C6C6C8" />
                    <ColorSwatch name="System Gray" color="#8E8E93" textColor="#FFF" />
                    <ColorSwatch name="System Gray 2" color="#AEAEB2" />
                    <ColorSwatch name="System Gray 3" color="#C7C7CC" />
                    <ColorSwatch name="System Gray 4" color="#D1D1D6" />
                    <ColorSwatch name="System Gray 5" color="#E5E5EA" />
                    <ColorSwatch name="System Gray 6" color="#F2F2F7" />
                </View>

                {/* Backgrounds */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4" style={Typography.default('semiBold')}>
                        Backgrounds
                    </Text>
                    
                    <ColorSwatch name="System Background" color="#FFFFFF" />
                    <ColorSwatch name="Secondary System Background" color="#F2F2F7" />
                    <ColorSwatch name="Tertiary System Background" color="#FFFFFF" />
                    <ColorSwatch name="System Grouped Background" color="#F2F2F7" />
                    <ColorSwatch name="Secondary System Grouped" color="#FFFFFF" />
                </View>

                {/* Component Colors */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4" style={Typography.default('semiBold')}>
                        Component Colors
                    </Text>
                    
                    <ColorPair name="List Item" bg="#FFFFFF" text="#000000" />
                    <ColorPair name="List Item (Pressed)" bg="#D1D1D6" text="#000000" />
                    <ColorPair name="List Item (Selected)" bg="#007AFF" text="#FFFFFF" />
                    <ColorPair name="List Item (Destructive)" bg="#FFFFFF" text="#FF3B30" />
                    <ColorPair name="List Group Header" bg="transparent" text="#8E8E93" />
                </View>

                {/* Usage in Code */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4" style={Typography.default('semiBold')}>
                        Usage Examples
                    </Text>
                    
                    <View className="bg-gray-100 p-4 rounded-lg">
                        <Text style={{ ...Typography.mono(), fontSize: 12 }}>
{`// iOS System Colors
const tintColor = '#007AFF';
const successColor = '#34C759';
const warningColor = '#FF9500';
const destructiveColor = '#FF3B30';

// Gray Scale
const labelColor = '#000000';
const secondaryLabel = '#8E8E93';
const separator = '#C6C6C8';
const systemGray = '#8E8E93';

// Backgrounds
const background = '#FFFFFF';
const groupedBackground = '#F2F2F7';`}
                        </Text>
                    </View>
                </View>

                {/* Tailwind/NativeWind Classes */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4" style={Typography.default('semiBold')}>
                        NativeWind Classes
                    </Text>
                    
                    <View className="space-y-2">
                        <View className="bg-blue-500 p-3 rounded">
                            <Text className="text-white">bg-blue-500</Text>
                        </View>
                        <View className="bg-green-500 p-3 rounded">
                            <Text className="text-white">bg-green-500</Text>
                        </View>
                        <View className="bg-red-500 p-3 rounded">
                            <Text className="text-white">bg-red-500</Text>
                        </View>
                        <View className="bg-gray-100 p-3 rounded">
                            <Text className="text-gray-900">bg-gray-100</Text>
                        </View>
                        <View className="bg-gray-200 p-3 rounded">
                            <Text className="text-gray-900">bg-gray-200</Text>
                        </View>
                        <View className="bg-gray-800 p-3 rounded">
                            <Text className="text-white">bg-gray-800</Text>
                        </View>
                    </View>
                </View>
            </View>
        </ScrollView>
    );
}