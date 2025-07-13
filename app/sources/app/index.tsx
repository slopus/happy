import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { CameraView } from 'expo-camera';
import * as React from 'react';
import { decodeBase64, encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useSessions } from "@/sync/useSessions";
import { useUpdates } from "@/hooks/useUpdates";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SessionsList } from "@/components/SessionsList";
import { Session } from "@/sync/types";

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
    const { sessions: realSessions, isLoaded } = useSessions();
    const { updateAvailable, reloadApp } = useUpdates();

    // Demo data for testing
    const sessions = React.useMemo((): Session[] => {
        if (realSessions.length > 0) return realSessions;
        
        const now = Date.now();
        const hour = 60 * 60 * 1000;
        const day = 24 * hour;
        
        return [
            {
                id: 'demo-1',
                seq: 5,
                createdAt: now - 2 * hour,
                updatedAt: now - 30 * 60 * 1000,
                lastMessage: {
                    type: 'assistant' as const,
                    content: {
                        type: 'text' as const,
                        text: 'I can help you build a React Native app with Expo. What would you like to create?'
                    }
                }
            },
            {
                id: 'demo-2',
                seq: 3,
                createdAt: now - 5 * hour,
                updatedAt: now - 3 * hour,
                lastMessage: {
                    type: 'human' as const,
                    content: {
                        type: 'text' as const,
                        text: 'Can you explain how Socket.IO works?'
                    }
                }
            },
            {
                id: 'demo-3',
                seq: 8,
                createdAt: now - day - 5 * hour,
                updatedAt: now - day - 2 * hour,
                lastMessage: {
                    type: 'assistant' as const,
                    content: {
                        type: 'text' as const,
                        text: 'The TypeScript error has been fixed. The component now properly validates all props.'
                    }
                }
            },
            {
                id: 'demo-4',
                seq: 2,
                createdAt: now - 3 * day,
                updatedAt: now - 3 * day,
                lastMessage: {
                    type: 'human' as const,
                    content: {
                        type: 'text' as const,
                        text: 'Initialize a new Next.js project with TypeScript'
                    }
                }
            },
            {
                id: 'demo-5',
                seq: 12,
                createdAt: now - 10 * day,
                updatedAt: now - 8 * day,
                lastMessage: {
                    type: 'assistant' as const,
                    content: {
                        type: 'text' as const,
                        text: 'I\'ve implemented the authentication flow with JWT tokens and secure storage. The login component is ready.'
                    }
                }
            },
            {
                id: 'demo-6',
                seq: 1,
                createdAt: now - 15 * day,
                updatedAt: now - 15 * day,
                lastMessage: null
            }
        ];
    }, [realSessions]);

    if (!isLoaded) {
        return (
            <View style={{ flexGrow: 1, flexBasis: 0, alignItems: 'center', justifyContent: 'center', marginBottom: 32 }}>
                <ActivityIndicator size="small" color="#000000" />
            </View>
        )
    }

    return (
        <View style={{ flex: 1 }}>
            {updateAvailable && <UpdateBanner onReload={reloadApp} />}

            {sessions.length === 0 ? (
                <View style={{ flexGrow: 1, flexBasis: 0, alignItems: 'center', justifyContent: 'center', marginBottom: 32 }}>
                    <Text>No sessions</Text>
                </View>
            ) : (
                <SessionsList sessions={sessions} />
            )}
        </View>
    )
}

function NotAuthenticated() {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);

    React.useEffect(() => {
        const subscription = CameraView.onModernBarcodeScanned(async (event) => {
            if (event.data.startsWith('handy://')) {
                setIsLoading(true);
                await CameraView.dismissScanner();
                try {
                    const tail = event.data.slice('handy://'.length);

                    // Read secret
                    console.log(tail);
                    const secret = decodeBase64(tail, 'base64url');
                    console.log(secret);
                    if (secret.length !== 32) {
                        throw new Error('Invalid secret');
                    }

                    // Exchange secret for token
                    const token = await authGetToken(secret);
                    console.log(token);

                    if (token && secret) {
                        await auth.login(token, encodeBase64(secret, 'base64url'));
                    }
                } catch (e) {
                    console.error(e);
                    Alert.alert('Error', 'Failed to login', [{ text: 'OK' }]);
                } finally {
                    setIsLoading(false);
                }
            }
        });
        return () => {
            subscription.remove();
        };
    }, [auth]);

    const openCamera = async () => {
        await CameraView.launchScanner({
            barcodeTypes: ['qr']
        });
    }

    return (
        <View style={{ flexGrow: 1, flexBasis: 0, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="qr-code-outline" size={120} color="#000" style={{ marginBottom: 32 }} />
            <Text style={{ textAlign: 'center', fontSize: 24, marginBottom: 32, marginHorizontal: 32 }}>
                Scan the QR code from your terminal to login
            </Text>
            <View style={{ maxWidth: 200, width: '100%' }}>
                <RoundButton
                    loading={isLoading ? true : undefined}
                    title="Open Camera"
                    action={openCamera} />
            </View>
        </View>
    )
}