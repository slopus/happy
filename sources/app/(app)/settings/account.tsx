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
import { getServerInfo, isUsingCustomServer } from '@/sync/serverConfig';
import { useUnistyles } from 'react-native-unistyles';

export default React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const [showSecret, setShowSecret] = useState(false);
    const [copiedRecently, setCopiedRecently] = useState(false);
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');

    // Get the current secret key
    const currentSecret = auth.credentials?.secret || '';
    const formattedSecret = currentSecret ? formatSecretKeyForBackup(currentSecret) : '';

    // Get server info
    const serverInfo = getServerInfo();

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
                        copy={!!sync.anonID}
                    />
                    <Item
                        title="Public ID"
                        detail={sync.serverID || "Not available"}
                        showChevron={false}
                        copy={!!sync.serverID}
                    />
                </ItemGroup>

                {/* Server Info */}
                {serverInfo.isCustom && (
                    <ItemGroup title="Server">
                        <Item
                            title="Server"
                            detail={serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '')}
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

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
                                backgroundColor: theme.colors.cardBackground,
                                paddingHorizontal: 16,
                                paddingVertical: 14,
                                width: '100%',
                                maxWidth: layout.maxWidth,
                                alignSelf: 'center'
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: theme.colors.subtitleText,
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        ...Typography.default('semiBold')
                                    }}>
                                        SECRET KEY (TAP TO COPY)
                                    </Text>
                                    <Ionicons
                                        name={copiedRecently ? "checkmark-circle" : "copy-outline"}
                                        size={18}
                                        color={copiedRecently ? "#34C759" : theme.colors.subtitleText}
                                    />
                                </View>
                                <Text style={{
                                    fontSize: 13,
                                    letterSpacing: 0.5,
                                    lineHeight: 20,
                                    color: theme.colors.titleText,
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