import * as React from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { Typography } from '@/constants/Typography';

const ColorSwatch = ({ name, color, textColor = '#000' }: { name: string; color: string; textColor?: string }) => (
    <View style={styles.swatchContainer}>
        <View 
            style={[styles.swatch, { backgroundColor: color }]}
        >
            <Text style={{ color: textColor, ...Typography.default('semiBold') }}>{name}</Text>
            <Text style={{ color: textColor, ...Typography.mono(), fontSize: 12 }}>{color}</Text>
        </View>
    </View>
);

const ColorPair = ({ name, bg, text }: { name: string; bg: string; text: string }) => (
    <View style={styles.swatchContainer}>
        <View 
            style={[styles.swatch, { backgroundColor: bg }]}
        >
            <Text style={{ color: text, ...Typography.default('semiBold'), marginBottom: 4 }}>{name}</Text>
            <Text style={{ color: text, ...Typography.mono(), fontSize: 12 }}>BG: {bg}</Text>
            <Text style={{ color: text, ...Typography.mono(), fontSize: 12 }}>Text: {text}</Text>
        </View>
    </View>
);

export default function ColorsScreen() {
    return (
        <ScrollView style={styles.container}>
            <View style={styles.content}>
                {/* iOS System Colors */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, Typography.default('semiBold')]}>
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
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, Typography.default('semiBold')]}>
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
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, Typography.default('semiBold')]}>
                        Backgrounds
                    </Text>
                    
                    <ColorSwatch name="System Background" color="#FFFFFF" />
                    <ColorSwatch name="Secondary System Background" color="#F2F2F7" />
                    <ColorSwatch name="Tertiary System Background" color="#FFFFFF" />
                    <ColorSwatch name="System Grouped Background" color="#F2F2F7" />
                    <ColorSwatch name="Secondary System Grouped" color="#FFFFFF" />
                </View>

                {/* Component Colors */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, Typography.default('semiBold')]}>
                        Component Colors
                    </Text>
                    
                    <ColorPair name="List Item" bg="#FFFFFF" text="#000000" />
                    <ColorPair name="List Item (Pressed)" bg="#D1D1D6" text="#000000" />
                    <ColorPair name="List Item (Selected)" bg="#007AFF" text="#FFFFFF" />
                    <ColorPair name="List Item (Destructive)" bg="#FFFFFF" text="#FF3B30" />
                    <ColorPair name="List Group Header" bg="transparent" text="#8E8E93" />
                </View>

                {/* Usage in Code */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, Typography.default('semiBold')]}>
                        Usage Examples
                    </Text>
                    
                    <View style={styles.codeBlock}>
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
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, Typography.default('semiBold')]}>
                        NativeWind Classes
                    </Text>
                    
                    <View style={styles.colorGrid}>
                        <View style={[styles.colorItem, { backgroundColor: '#3b82f6' }]}>
                            <Text style={styles.colorItemTextWhite}>bg-blue-500</Text>
                        </View>
                        <View style={[styles.colorItem, { backgroundColor: '#10b981' }]}>
                            <Text style={styles.colorItemTextWhite}>bg-green-500</Text>
                        </View>
                        <View style={[styles.colorItem, { backgroundColor: '#ef4444' }]}>
                            <Text style={styles.colorItemTextWhite}>bg-red-500</Text>
                        </View>
                        <View style={[styles.colorItem, { backgroundColor: '#f3f4f6' }]}>
                            <Text style={styles.colorItemTextDark}>bg-gray-100</Text>
                        </View>
                        <View style={[styles.colorItem, { backgroundColor: '#e5e7eb' }]}>
                            <Text style={styles.colorItemTextDark}>bg-gray-200</Text>
                        </View>
                        <View style={[styles.colorItem, { backgroundColor: '#1f2937' }]}>
                            <Text style={styles.colorItemTextWhite}>bg-gray-800</Text>
                        </View>
                    </View>
                </View>
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'white',
    },
    content: {
        padding: 16,
    },
    section: {
        marginBottom: 32,
    },
    sectionTitle: {
        fontSize: 20,
        marginBottom: 16,
    },
    swatchContainer: {
        marginBottom: 16,
    },
    swatch: {
        borderRadius: 8,
        padding: 16,
        marginBottom: 8,
    },
    codeBlock: {
        backgroundColor: '#f0f0f0',
        padding: 16,
        borderRadius: 8,
    },
    colorGrid: {
        gap: 8,
    },
    colorItem: {
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
    },
    colorItemTextWhite: {
        color: 'white',
    },
    colorItemTextDark: {
        color: '#111827',
    },
});