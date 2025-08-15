import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Image, Pressable, Text, View, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useUpdates } from "@/hooks/useUpdates";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SessionsList } from "@/components/SessionsList";
import { Stack, useRouter } from "expo-router";
import { useSessionListViewData, useEntitlement, useSocketStatus } from "@/sync/storage";
import { getRandomBytesAsync } from "expo-crypto";
import { useIsTablet, useIsLandscape } from "@/utils/responsive";
import { Typography } from "@/constants/Typography";
import { EmptyMainScreen } from "@/components/EmptyMainScreen";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { getServerInfo } from "@/sync/serverConfig";
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { StatusDot } from '@/components/StatusDot';

// Header title component with subtitle
function HeaderTitleWithSubtitle({ subtitle }: { subtitle?: string }) {
    const socketStatus = useSocketStatus();
    
    // Get connection status styling (matching sessionUtils.ts pattern)
    const getConnectionStatus = () => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return { 
                    color: '#34C759', 
                    isPulsing: false,
                    text: 'connected',
                    textColor: '#34C759'
                };
            case 'connecting':
                return { 
                    color: '#007AFF', 
                    isPulsing: true,
                    text: 'connecting',
                    textColor: '#007AFF'
                };
            case 'disconnected':
                return { 
                    color: '#999', 
                    isPulsing: false,
                    text: 'disconnected',
                    textColor: '#999'
                };
            case 'error':
                return { 
                    color: '#FF3B30', 
                    isPulsing: false,
                    text: 'connection error',
                    textColor: '#FF3B30'
                };
            default:
                return { 
                    color: '#8E8E93', 
                    isPulsing: false,
                    text: '',
                    textColor: '#8E8E93'
                };
        }
    };
    
    const hasCustomSubtitle = !!subtitle;
    const connectionStatus = getConnectionStatus();
    const showConnectionStatus = !hasCustomSubtitle && connectionStatus.text;
    const titleFontSize = (hasCustomSubtitle || showConnectionStatus) ? 20 : 24;
    
    return (
        <View style={{ alignItems: 'center' }}>
            <Text style={{ fontSize: titleFontSize, color: '#000', ...Typography.logo() }}>
                Happy Coder
            </Text>
            {hasCustomSubtitle && (
                <Text style={{ fontSize: 12, color: '#8E8E93', marginTop: 2 }}>
                    {subtitle}
                </Text>
            )}
            {showConnectionStatus && (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                    <StatusDot 
                        color={connectionStatus.color} 
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={{ marginRight: 4 }}
                    />
                    <Text style={{ 
                        fontSize: 12, 
                        color: connectionStatus.textColor,
                        fontWeight: '500',
                        lineHeight: 16,
                        ...Typography.default()
                    }}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </View>
    );
}

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    const sessionListViewData = useSessionListViewData();
    const { updateAvailable, reloadApp } = useUpdates();
    const isTablet = useIsTablet();

    const auth = useAuth();
    const [showLogoutButton, setShowLogoutButton] = React.useState(false);
    
    // Show logout button after 2 seconds if still loading
    React.useEffect(() => {
        if (sessionListViewData === null) {
            const timer = setTimeout(() => {
                setShowLogoutButton(true);
            }, 2000);
            
            return () => clearTimeout(timer);
        } else {
            setShowLogoutButton(false);
        }
    }, [sessionListViewData]);
    
    const handleCopyAndLogout = async () => {
        const currentSecret = auth.credentials?.secret || '';
        
        const confirmed = await Modal.confirm(
            'Copy backup login phrase and logout',
            'This will copy your backup phrase to clipboard and log you out. Make sure to save your backup phrase in a secure place!',
            { confirmText: 'Copy and Logout', destructive: true }
        );
        
        if (confirmed) {
            try {
                await Clipboard.setStringAsync(currentSecret);
                Modal.alert('Success', 'Backup phrase copied to clipboard. Logging out now...');
                auth.logout();
            } catch (error) {
                Modal.alert('Error', 'Failed to copy backup phrase. Please try again.');
            }
        }
    };

    // Empty state in tabled view
    if (isTablet) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: false
                    }}
                />
                <View style={{ flex: 1, flexBasis: 0, flexGrow: 1 }}>
                    {sessionListViewData === null && (
                        <View style={{ flex: 1, flexBasis: 0, flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
                            <ActivityIndicator />
                            {showLogoutButton && (
                                <View style={{ marginTop: 32 }}>
                                    <RoundButton
                                        title="Copy backup login phrase and logout"
                                        onPress={handleCopyAndLogout}
                                        display="inverted"
                                        size="normal"
                                    />
                                </View>
                            )}
                        </View>
                    )}
                    {sessionListViewData !== null && sessionListViewData.length === 0 && (
                        <EmptyMainScreen />
                    )}
                </View>
            </>
        )
    }

    if (sessionListViewData === null) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: () => <HeaderTitleWithSubtitle />,
                        headerRight: () => <HeaderRight />
                    }}
                />
                <View className="flex-1 items-center justify-center mb-8">
                    <ActivityIndicator size="small" color="#000000" />
                    {showLogoutButton && (
                    <View style={{ marginTop: 32, paddingHorizontal: 32, width: '100%', maxWidth: 300 }}>
                        <RoundButton
                            title="Copy backup login phrase and logout"
                            onPress={handleCopyAndLogout}
                            display="inverted"
                            size="normal"
                        />
                    </View>
                )}
                </View>
            </>
        )
    }

    const emptyState = <EmptyMainScreen />;

    // On phones, use the existing navigation pattern
    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: () => <HeaderTitleWithSubtitle />,
                    headerLeft: () => <HeaderLeft />,
                    headerRight: () => <HeaderRight />
                }}
            />
            <View className="flex-1">
                {updateAvailable && <UpdateBanner onReload={reloadApp} />}
                {!sessionListViewData || sessionListViewData.length === 0 ? emptyState : (
                    <SessionsList />
                )}
            </View>
        </>
    );
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();

    const createAccount = async () => {
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
                trackAccountCreated();
            }
        } catch (error) {
            console.error('Error creating account', error);
        }
    }

    const portraitLayout = (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Image source={require('@/assets/images/happy-otter-2.png')} style={{ width: 200, height: 140 }} />
            <Text style={{ marginTop: 16, textAlign: 'center', fontSize: 24, ...Typography.default('semiBold') }}>
                Claude Code mobile client
            </Text>
            <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)', marginTop: 16, textAlign: 'center', marginHorizontal: 24, marginBottom: 64 }}>
                End-to-end encrypted and your account is stored only on your device.
            </Text>
            <View style={{ maxWidth: 200, width: '100%', marginBottom: 16 }}>
                <RoundButton
                    title="Create account"
                    action={createAccount}
                />
            </View>
            <View style={{ maxWidth: 200, width: '100%' }}>
                <RoundButton
                    size="normal"
                    title="Restore account"
                    onPress={() => {
                        trackAccountRestored();
                        router.push('/restore');
                    }}
                    display="inverted"
                />
            </View>
        </View>
    );

    const landscapeLayout = (
        <View style={{
            flexBasis: 0,
            flexGrow: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 48,
            paddingBottom: insets.bottom + 24
        }}>
            <View style={{ flexGrow: 1, flexBasis: 0, maxWidth: 800, flexDirection: 'row' }}>
                <View style={{
                    flexBasis: 0, flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingRight: 24
                }}>
                    <Image source={require('@/assets/images/happy-otter-2.png')} style={{ width: 200, height: 140 }} />
                </View>
                <View style={{
                    flexBasis: 0,
                    flexGrow: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingLeft: 24
                }}>
                    <Text style={{ textAlign: 'center', fontSize: 24, ...Typography.default('semiBold') }}>
                        Claude Code mobile client
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)', marginTop: 16, textAlign: 'center', marginBottom: 32, paddingHorizontal: 16 }}>
                        End-to-end encrypted and your account is stored only on your device.
                    </Text>
                    <View style={{ width: 240, marginBottom: 16 }}>
                        <RoundButton
                            title="Create account"
                            action={createAccount}
                        />
                    </View>
                    <View style={{ width: 240 }}>
                        <RoundButton
                            size="normal"
                            title="Restore account"
                            onPress={() => {
                                trackAccountRestored();
                                router.push('/restore');
                            }}
                            display="inverted"
                        />
                    </View>
                </View>
            </View>
        </View>
    );

    const serverInfo = getServerInfo(); // Re-rendered automatically when screen navigates back
    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: () => <HeaderTitleWithSubtitle subtitle={serverInfo.isCustom ? serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '') : undefined} />,
                    headerRight: () => <HeaderRightNotAuth />
                }}
            />
            {isLandscape ? landscapeLayout : portraitLayout}
        </>
    )
}

function HeaderLeft() {
    const router = useRouter();

    return (
        <Pressable
            onPress={() => router.push('/settings')}
            hitSlop={15}
        >
            <Ionicons name="settings-outline" size={24} color="#000" />
        </Pressable>
    );
}

function HeaderRight() {
    const router = useRouter();
    
    return (
        <Pressable
            onPress={() => router.push('/new-session')}
            hitSlop={15}
        >
            <Ionicons name="add-circle-outline" size={28} color="#000" />
        </Pressable>
    );
}

function HeaderRightNotAuth() {
    const router = useRouter();

    return (
        <Pressable
            onPress={() => router.push('/server')}
            hitSlop={15}
        >
            <Ionicons name="server-outline" size={24} color="#000" />
        </Pressable>
    );
}