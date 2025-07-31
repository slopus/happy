import React from 'react';
import { View, Text, Platform } from 'react-native';
import { Typography } from '@/constants/Typography';
import { ConnectButton } from '@/components/ConnectButton';

export function EmptyMainScreen() {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 32 }}>
            {/* Terminal-style code block */}
            <Text style={{ marginBottom: 16, textAlign: 'center', fontSize: 24, ...Typography.default('semiBold') }}>Ready to code?</Text>
            <View style={{
                backgroundColor: '#444',
                borderRadius: 8,
                padding: 20,
                marginHorizontal: 24,
                marginBottom: 20,
                borderWidth: 1,
                borderColor: '#333'
            }}>

                <Text style={{ ...Typography.mono(), fontSize: 16, color: '#00ff00', marginBottom: 8 }}>
                    $ npm i -g happy-coder
                </Text>
                <Text style={{ ...Typography.mono(), fontSize: 16, color: '#00ff00' }}>
                    $ happy
                </Text>
            </View>


            {Platform.OS !== 'web' && (
                <>
                    <View style={{ marginTop: 12, marginHorizontal: 24, marginBottom: 64, width: 250 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: 'rgba(0,0,0,0.7)' }}>1</Text>
                            </View>
                            <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)' }}>
                                Install the Happy CLI
                            </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: 'rgba(0,0,0,0.7)' }}>2</Text>
                            </View>
                            <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)' }}>
                                Run it
                            </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: 'rgba(0,0,0,0.7)' }}>3</Text>
                            </View>
                            <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)' }}>
                                Scan the QR code
                            </Text>
                        </View>
                    </View>
                    <ConnectButton />
                </>
            )}
        </View>
    );
}