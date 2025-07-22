import * as React from 'react';
import { ScrollView, View, Text } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';

const TextSample = ({ title, style, text = "The quick brown fox jumps over the lazy dog" }: { title: string; style: any; text?: string }) => (
    <View className="mb-6">
        <Text className="text-sm text-gray-500 mb-1">{title}</Text>
        <Text style={[{ fontSize: 16 }, style]}>{text}</Text>
    </View>
);

const CodeSample = ({ title, style }: { title: string; style: any }) => (
    <View className="mb-6">
        <Text className="text-sm text-gray-500 mb-1">{title}</Text>
        <Text style={[{ fontSize: 14 }, style]}>
            {`const greeting = "Hello, World!";\nconsole.log(greeting);`}
        </Text>
    </View>
);

export default function TypographyScreen() {
    return (
        <ScrollView className="flex-1 bg-white">
            <View className="p-4">
                {/* IBM Plex Sans (Default) */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4">IBM Plex Sans (Default)</Text>
                    
                    <TextSample 
                        title="Regular (400)" 
                        style={Typography.default()}
                    />
                    
                    <TextSample 
                        title="Italic" 
                        style={Typography.default('italic')}
                    />
                    
                    <TextSample 
                        title="Semi-Bold (600)" 
                        style={Typography.default('semiBold')}
                    />
                </View>

                {/* IBM Plex Mono */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4">IBM Plex Mono</Text>
                    
                    <CodeSample 
                        title="Regular (400)" 
                        style={Typography.mono()}
                    />
                    
                    <CodeSample 
                        title="Italic" 
                        style={Typography.mono('italic')}
                    />
                    
                    <CodeSample 
                        title="Semi-Bold (600)" 
                        style={Typography.mono('semiBold')}
                    />
                </View>

                {/* Bricolage Grotesque (Logo) */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4">Bricolage Grotesque (Logo)</Text>
                    
                    <TextSample 
                        title="Bold (700) - Logo Only" 
                        style={{ fontSize: 28, ...Typography.logo() }}
                        text="Happy Coder"
                    />
                    <Text className="text-sm text-gray-500 mt-2">
                        Note: This font should only be used for the app logo and branding
                    </Text>
                </View>

                {/* Font Sizes */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4">Font Size Scale</Text>
                    
                    {[12, 14, 16, 18, 20, 24, 28, 32, 36].map(size => (
                        <View key={size} className="mb-3">
                            <Text style={{ fontSize: size, ...Typography.default() }}>
                                {size}px - The quick brown fox
                            </Text>
                        </View>
                    ))}
                </View>

                {/* Text in Components */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4">Typography in Components</Text>
                    
                    <ItemGroup title="List Item Typography">
                        <Item 
                            title="Default Title (17px regular)"
                            subtitle="Default Subtitle (15px regular, #8E8E93)"
                            detail="Detail"
                        />
                        <Item 
                            title="With Custom Title Style"
                            titleStyle={{ ...Typography.default('semiBold') }}
                            subtitle="Using semi-bold for title"
                        />
                        <Item 
                            title="Monospace Detail"
                            detail="v1.0.0"
                            detailStyle={{ ...Typography.mono() }}
                        />
                    </ItemGroup>
                </View>

                {/* Usage Examples */}
                <View className="mb-8">
                    <Text className="text-xl font-semibold mb-4">Usage Examples</Text>
                    
                    <View className="bg-gray-100 p-4 rounded-lg">
                        <Text style={{ ...Typography.mono(), fontSize: 12 }}>
{`// Default typography (IBM Plex Sans)
<Text style={{ fontSize: 16, ...Typography.default() }}>Regular</Text>
<Text style={{ fontSize: 16, ...Typography.default('semiBold') }}>Bold</Text>

// Monospace typography (IBM Plex Mono)
<Text style={{ fontSize: 14, ...Typography.mono() }}>Code</Text>

// Logo typography (Bricolage Grotesque)
<Text style={{ fontSize: 28, ...Typography.logo() }}>Logo</Text>`}
                        </Text>
                    </View>
                </View>
            </View>
        </ScrollView>
    );
}