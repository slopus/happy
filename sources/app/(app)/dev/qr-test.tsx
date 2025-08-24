import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView } from 'react-native';
import { QRCode } from '@/components/qr';
import { RoundButton } from '@/components/RoundButton';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        padding: 20,
    },
    section: {
        marginBottom: 30,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 15,
        ...Typography.default(),
    },
    input: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 15,
        color: theme.colors.input.text,
        fontSize: 16,
    },
    qrContainer: {
        alignItems: 'center',
        marginVertical: 15,
        padding: 15,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
    },
    qrLabel: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 10,
        textAlign: 'center',
        ...Typography.default(),
    },
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-around',
    },
}));

export default function QRTest() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [customData, setCustomData] = useState('Hello World!');

    const testData = [
        { label: 'Simple Text', data: 'Hello QR Code!' },
        { label: 'URL', data: 'https://github.com/slopus/happy' },
        { label: 'Email', data: 'mailto:test@example.com' },
        { label: 'Phone', data: 'tel:+1234567890' },
        { label: 'WiFi', data: 'WIFI:T:WPA;S:MyNetwork;P:password123;H:false;;' },
    ];

    const sizes = [100, 150, 200, 250];
    const errorLevels: Array<'low' | 'medium' | 'quartile' | 'high'> = ['low', 'medium', 'quartile', 'high'];

    return (
        <ScrollView style={styles.container}>
            {/* Custom QR Code */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Custom QR Code</Text>
                <TextInput
                    style={styles.input}
                    value={customData}
                    onChangeText={setCustomData}
                    placeholder="Enter your data here..."
                    placeholderTextColor={theme.colors.input.placeholder}
                    multiline
                />
                <View style={styles.qrContainer}>
                    <Text style={styles.qrLabel}>Custom Data</Text>
                    <QRCode data={customData} size={200} />
                </View>
            </View>

            {/* Predefined Examples */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Example QR Codes</Text>
                {testData.map((item, index) => (
                    <View key={index} style={styles.qrContainer}>
                        <Text style={styles.qrLabel}>{item.label}: {item.data}</Text>
                        <QRCode data={item.data} size={180} />
                    </View>
                ))}
            </View>

            {/* Different Sizes */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Different Sizes</Text>
                <View style={styles.row}>
                    {sizes.map((size) => (
                        <View key={size} style={[styles.qrContainer, { margin: 5 }]}>
                            <Text style={styles.qrLabel}>{size}x{size}</Text>
                            <QRCode data="Size test" size={size} />
                        </View>
                    ))}
                </View>
            </View>

            {/* Error Correction Levels */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Error Correction Levels</Text>
                <View style={styles.row}>
                    {errorLevels.map((level) => (
                        <View key={level} style={[styles.qrContainer, { margin: 5 }]}>
                            <Text style={styles.qrLabel}>{level.toUpperCase()}</Text>
                            <QRCode 
                                data="Error correction test with some longer text to see differences"
                                size={150} 
                                errorCorrectionLevel={level}
                            />
                        </View>
                    ))}
                </View>
            </View>

            {/* Color Variations */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Color Variations</Text>
                <View style={styles.row}>
                    <View style={[styles.qrContainer, { margin: 5 }]}>
                        <Text style={styles.qrLabel}>Blue on White</Text>
                        <QRCode 
                            data="Blue QR Code" 
                            size={150} 
                            foregroundColor="#0066CC"
                            backgroundColor="#FFFFFF"
                        />
                    </View>
                    <View style={[styles.qrContainer, { margin: 5 }]}>
                        <Text style={styles.qrLabel}>White on Dark</Text>
                        <QRCode 
                            data="White QR Code" 
                            size={150} 
                            foregroundColor="#FFFFFF"
                            backgroundColor="#333333"
                        />
                    </View>
                </View>
            </View>

            {/* Long Text Test */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Long Text Handling</Text>
                <View style={styles.qrContainer}>
                    <Text style={styles.qrLabel}>Long text with multiple lines</Text>
                    <QRCode 
                        data="This is a very long text that should be encoded into a QR code to test how the component handles larger amounts of data. The QR code should automatically adjust its version to accommodate all this text while maintaining readability and scannability."
                        size={250}
                        errorCorrectionLevel="high"
                    />
                </View>
            </View>
        </ScrollView>
    );
}