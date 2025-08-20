import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Switch, Dimensions } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

const { width: screenWidth } = Dimensions.get('window');

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.primary,
    },
    scrollContent: {
        padding: 16,
        paddingBottom: 32,
    },
    section: {
        marginBottom: 24,
        backgroundColor: theme.colors.cardBackground,
        borderRadius: 12,
        padding: 16,
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.1,
        shadowRadius: 3.84,
        elevation: 5,
    },
    sectionTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 12,
        color: '#333',
    },
    themeCard: {
        padding: 16,
        borderRadius: 8,
        marginBottom: 12,
        backgroundColor: theme.colors.primary,
        borderWidth: 2,
        borderColor: theme.colors.primary,
    },
    themeText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
        textAlign: 'center',
    },
    breakpointBox: {
        padding: 12,
        margin: 4,
        borderRadius: 8,
        backgroundColor: {
            xs: '#FF6B6B',
            sm: '#4ECDC4',
            md: '#45B7D1',
            lg: '#96CEB4',
            xl: '#FECA57',
        },
        minHeight: 60,
        justifyContent: 'center',
        alignItems: 'center',
    },
    breakpointText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: {
            xs: 12,
            sm: 14,
            md: 16,
            lg: 18,
            xl: 20,
        },
    },
    responsiveContainer: {
        flexDirection: {
            xs: 'column',
            md: 'row',
        },
    },
    responsiveBox: {
        flex: 1,
        backgroundColor: theme.colors.primary,
        padding: 16,
        borderRadius: 8,
        minHeight: 80,
        justifyContent: 'center',
        alignItems: 'center',
    },
    orientationBox: {
        backgroundColor: {
            portrait: '#E74C3C',
            landscape: '#2ECC71',
        },
        padding: 20,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 80,
    },
    orientationText: {
        color: 'white',
        fontSize: 16,
        fontWeight: 'bold',
    },
    runtimeBox: {
        backgroundColor: '#9B59B6',
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
    },
    runtimeText: {
        color: 'white',
        fontSize: 14,
        fontFamily: 'monospace',
    },
    themeButton: {
        backgroundColor: theme.colors.primary,
        padding: 12,
        borderRadius: 8,
        marginHorizontal: 4,
        minWidth: 80,
        alignItems: 'center',
    },
    themeButtonText: {
        color: 'white',
        fontWeight: '600',
    },
    switchContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    adaptiveBox: {
        backgroundColor: theme.colors.primary,
        padding: {
            xs: 8,
            sm: 12,
            md: 16,
            lg: 20,
            xl: 24,
        },
        borderRadius: {
            xs: 4,
            sm: 6,
            md: 8,
            lg: 10,
            xl: 12,
        },
        marginBottom: 8,
    },
    adaptiveText: {
        color: 'white',
        fontSize: {
            xs: 12,
            sm: 14,
            md: 16,
            lg: 18,
            xl: 20,
        },
        textAlign: 'center',
    },
}));

export default function UnistylesDemo() {
    const { theme, rt } = useUnistyles();
    const styles = stylesheet;
    const [showRuntimeInfo, setShowRuntimeInfo] = useState(true);

    const switchTheme = (themeName: 'light' | 'dark') => {  
        UnistylesRuntime.setTheme(themeName);
    };

    const toggleColorScheme = () => {
        // Note: ColorScheme is typically system-controlled in React Native
        console.log('Color scheme toggle requested - this would typically be system controlled');
    };

    return (
        <View style={styles.container}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent}>
                {/* Theme Demo */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>🎨 Theme System</Text>
                    <View style={styles.themeCard}>
                        <Text style={styles.themeText}>
                            Current Theme: {rt.themeName}
                        </Text>
                        <Text style={[styles.themeText, { fontSize: 14, opacity: 0.8 }]}>
                            Primary: {theme.colors.primary}
                        </Text>
                    </View>

                    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                        <Pressable
                            style={styles.themeButton}
                            onPress={() => switchTheme('light')}
                        >
                            <Text style={styles.themeButtonText}>Light</Text>
                        </Pressable>
                        <Pressable
                            style={styles.themeButton}
                            onPress={() => switchTheme('dark')}
                        >
                            <Text style={styles.themeButtonText}>Dark</Text>
                        </Pressable>
                    </View>
                </View>

                {/* Breakpoints Demo */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>📱 Responsive Breakpoints</Text>
                    <Text style={{ marginBottom: 12, color: '#666' }}>
                        Current: {rt.breakpoint} ({screenWidth}px)
                    </Text>

                    <View style={styles.breakpointBox}>
                        <Text style={styles.breakpointText}>
                            Active Breakpoint: {rt.breakpoint}
                        </Text>
                        <Text style={[styles.breakpointText, { fontSize: 12, opacity: 0.8 }]}>
                            Screen width: {rt.screen.width}px
                        </Text>
                    </View>

                    <View style={styles.responsiveContainer}>
                        <View style={styles.responsiveBox}>
                            <Text style={{ color: 'white', fontWeight: 'bold' }}>Box 1</Text>
                        </View>
                        <View style={styles.responsiveBox}>
                            <Text style={{ color: 'white', fontWeight: 'bold' }}>Box 2</Text>
                        </View>
                    </View>
                </View>

                {/* Orientation Demo */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>🔄 Orientation Styles</Text>
                    <View style={styles.orientationBox}>
                        <Ionicons
                            name={rt.isPortrait ? 'phone-portrait' : 'phone-landscape'}
                            size={24}
                            color="white"
                        />
                        <Text style={styles.orientationText}>
                            {rt.isPortrait ? 'Portrait' : 'Landscape'}
                        </Text>
                    </View>
                </View>

                {/* Adaptive Components */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>🎯 Adaptive Components</Text>
                    <Text style={{ marginBottom: 12, color: '#666' }}>
                        Padding and border radius adapt to screen size
                    </Text>

                    {['Tiny', 'Small', 'Medium', 'Large', 'Extra Large'].map((size, index) => (
                        <View key={size} style={styles.adaptiveBox}>
                            <Text style={styles.adaptiveText}>
                                {size} - Adapts to {rt.breakpoint}
                            </Text>
                        </View>
                    ))}
                </View>

                {/* Runtime Information */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>⚙️ Runtime Information</Text>

                    <View style={styles.switchContainer}>
                        <Text style={{ fontSize: 16, color: '#333' }}>Show Runtime Details</Text>
                        <Switch
                            value={showRuntimeInfo}
                            onValueChange={setShowRuntimeInfo}
                            trackColor={{ false: theme.colors.switchTrackInactive, true: theme.colors.switchTrackActive }}
                            thumbColor={theme.colors.switchThumb}
                        />
                    </View>

                    {showRuntimeInfo && (
                        <>
                            <View style={styles.runtimeBox}>
                                <Text style={styles.runtimeText}>
                                    Theme: {rt.themeName}
                                </Text>
                            </View>
                            <View style={styles.runtimeBox}>
                                <Text style={styles.runtimeText}>
                                    Breakpoint: {rt.breakpoint}
                                </Text>
                            </View>
                            <View style={styles.runtimeBox}>
                                <Text style={styles.runtimeText}>
                                    Screen: {rt.screen.width} × {rt.screen.height}
                                </Text>
                            </View>
                            <View style={styles.runtimeBox}>
                                <Text style={styles.runtimeText}>
                                    Orientation: {rt.isPortrait ? 'Portrait' : 'Landscape'}
                                </Text>
                            </View>
                            <View style={styles.runtimeBox}>
                                <Text style={styles.runtimeText}>
                                    Color Scheme: {rt.colorScheme}
                                </Text>
                            </View>
                            <View style={styles.runtimeBox}>
                                <Text style={styles.runtimeText}>
                                    Content Size: {rt.contentSizeCategory}
                                </Text>
                            </View>
                            <View style={styles.runtimeBox}>
                                <Text style={styles.runtimeText}>
                                    Has Dynamic Island: {rt.insets.top > 50 ? 'Yes' : 'No'}
                                </Text>
                            </View>
                            <View style={styles.runtimeBox}>
                                <Text style={styles.runtimeText}>
                                    Safe Insets: T:{rt.insets.top} B:{rt.insets.bottom} L:{rt.insets.left} R:{rt.insets.right}
                                </Text>
                            </View>
                        </>
                    )}

                    <Pressable
                        style={[styles.themeButton, { marginTop: 12 }]}
                        onPress={toggleColorScheme}
                    >
                        <Text style={styles.themeButtonText}>
                            Toggle Color Scheme ({rt.colorScheme})
                        </Text>
                    </Pressable>
                </View>

                {/* Color Scheme Demo */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>🌙 Color Scheme</Text>
                    <View style={{
                        backgroundColor: rt.colorScheme === 'dark' ? '#2C3E50' : '#ECF0F1',
                        padding: 16,
                        borderRadius: 8,
                    }}>
                        <Text style={{
                            color: rt.colorScheme === 'dark' ? 'white' : 'black',
                            textAlign: 'center',
                            fontSize: 16,
                            fontWeight: '600'
                        }}>
                            Current color scheme: {rt.colorScheme}
                        </Text>
                        <Text style={{
                            color: rt.colorScheme === 'dark' ? '#BDC3C7' : '#7F8C8D',
                            textAlign: 'center',
                            fontSize: 14,
                            marginTop: 4
                        }}>
                            This box adapts to system color scheme
                        </Text>
                    </View>
                </View>

                {/* Performance Note */}
                <View style={[styles.section, { backgroundColor: '#FFF3CD', borderColor: '#FFEAA7', borderWidth: 1 }]}>
                    <Text style={[styles.sectionTitle, { color: '#856404' }]}>⚡ Performance Note</Text>
                    <Text style={{ color: '#856404', lineHeight: 20 }}>
                        Unistyles compiles styles at build time and provides runtime optimizations.
                        All the responsive features you see here work without performance penalties
                        thanks to the native bridge integration.
                    </Text>
                </View>
            </ScrollView>
        </View>
    );
}