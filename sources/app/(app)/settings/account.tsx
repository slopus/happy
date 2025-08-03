import React, { useState } from 'react';
import { View, Text, Pressable, Platform, Switch } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { tracking } from '@/track/tracking';
import { useSettingMutable } from '@/sync/storage';
import { sync } from '@/sync/sync';

export default React.memo(() => {
    const auth = useAuth();
    const router = useRouter();
    const [showSecret, setShowSecret] = useState(false);
    const [copiedRecently, setCopiedRecently] = useState(false);
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');

    // Get the current secret key
    const currentSecret = auth.credentials?.secret || '';
    const formattedSecret = currentSecret ? formatSecretKeyForBackup(currentSecret) : '';

    const handleShowSecret = () => {
        setShowSecret(!showSecret);
    };

    const handleCopySecret = async () => {
        try {
            await Clipboard.setStringAsync(formattedSecret);
            setCopiedRecently(true);
            setTimeout(() => setCopiedRecently(false), 2000);
            Modal.alert('Success', 'Secret key copied to clipboard. Store it in a safe place!');
        } catch (error) {
            Modal.alert('Error', 'Failed to copy secret key');
        }
    };

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            'Logout',
            'Are you sure you want to logout? Make sure you have backed up your secret key!',
            { confirmText: 'Logout', destructive: true }
        );
        if (confirmed) {
            auth.logout();
        }
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: 'Account',
                    headerStyle: {
                        backgroundColor: 'white',
                    },
                    headerTintColor: '#000',
                    headerTitleStyle: {
                        color: '#000',
                        fontSize: 17,
                        fontWeight: '600',
                    }
                }}
            />

            <ItemList>
                {/* Account Info */}
                <ItemGroup title="Account Information">
                    <Item
                        title="Status"
                        detail={auth.isAuthenticated ? "Active" : "Not Authenticated"}
                        showChevron={false}
                    />
                    <Item
                        title="Anonymous ID"
                        detail={sync.anonID || "Not available"}
                        showChevron={false}
                    />
                    <Item
                        title="Public ID"
                        detail={sync.pubID || "Not available"}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Backup Section */}
                <ItemGroup
                    title="Backup"
                    footer="Your secret key is the only way to recover your account. Save it in a secure place like a password manager."
                >
                    <Item
                        title="Secret Key"
                        subtitle={showSecret ? "Tap to hide" : "Tap to reveal"}
                        icon={<Ionicons name={showSecret ? "eye-off-outline" : "eye-outline"} size={29} color="#FF9500" />}
                        onPress={handleShowSecret}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Secret Key Display */}
                {showSecret && (
                    <ItemGroup>
                        <Pressable onPress={handleCopySecret}>
                            <View style={{
                                backgroundColor: '#fff',
                                paddingHorizontal: 16,
                                paddingVertical: 14,
                                width: '100%',
                                maxWidth: layout.maxWidth,
                                alignSelf: 'center'
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: '#8E8E93',
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        ...Typography.default('semiBold')
                                    }}>
                                        SECRET KEY (TAP TO COPY)
                                    </Text>
                                    <Ionicons
                                        name={copiedRecently ? "checkmark-circle" : "copy-outline"}
                                        size={18}
                                        color={copiedRecently ? "#34C759" : "#8E8E93"}
                                    />
                                </View>
                                <Text style={{
                                    fontSize: 13,
                                    letterSpacing: 0.5,
                                    lineHeight: 20,
                                    color: '#000',
                                    ...Typography.mono()
                                }}>
                                    {formattedSecret}
                                </Text>
                            </View>
                        </Pressable>
                    </ItemGroup>
                )}

                {/* Analytics Section */}
                <ItemGroup 
                    title="Privacy"
                    footer="Help improve the app by sharing anonymous usage data. No personal information is collected."
                >
                    <Item
                        title="Analytics"
                        subtitle={analyticsOptOut ? "No data is shared" : "Anonymous usage data is shared"}
                        rightElement={
                            <Switch
                                value={!analyticsOptOut}
                                onValueChange={(value) => {
                                    const optOut = !value;
                                    setAnalyticsOptOut(optOut);
                                }}
                                trackColor={{ false: '#767577', true: '#34C759' }}
                                thumbColor="#FFFFFF"
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Danger Zone */}
                <ItemGroup title="Danger Zone">
                    <Item
                        title="Logout"
                        subtitle="Sign out and clear local data"
                        icon={<Ionicons name="log-out-outline" size={29} color="#FF3B30" />}
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
});