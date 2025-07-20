import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Fonts from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';
import * as React from 'react';

import { useColorScheme } from '@/components/useColorScheme';
import { AuthProvider } from '@/auth/AuthContext';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { Image, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Typography } from '@/constants/Typography';
import { DebugProvider } from '@/contexts/DebugContext';
import '../global.css';

export {
    // Catch any errors thrown by the Layout component.
    ErrorBoundary,
} from 'expo-router';

// Configure splash screen
SplashScreen.setOptions({
    fade: true,
    duration: 300,
})
SplashScreen.preventAutoHideAsync();

export const unstable_settings = {
    initialRouteName: 'index',
};

function HeaderRight() {
    const router = useRouter();

    return (
        <Pressable
            onPress={() => router.push('/about')}
            hitSlop={10}
        >
            <Image source={require('../assets/images/icon.png')} style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.2)' }} />
        </Pressable>
    );
}

export default function RootLayout() {
    const colorScheme = useColorScheme();

    // Load app
    const [initState, setInitState] = React.useState<{ credentials: AuthCredentials | null } | null>(null);
    React.useEffect(() => {
        (async () => {
            await Fonts.loadAsync({
                // Keep existing font
                SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
                
                // IBM Plex Sans family
                'IBMPlexSans-Regular': require('../assets/fonts/IBMPlexSans-Regular.ttf'),
                'IBMPlexSans-Italic': require('../assets/fonts/IBMPlexSans-Italic.ttf'),
                'IBMPlexSans-SemiBold': require('../assets/fonts/IBMPlexSans-SemiBold.ttf'),
                
                // IBM Plex Mono family  
                'IBMPlexMono-Regular': require('../assets/fonts/IBMPlexMono-Regular.ttf'),
                'IBMPlexMono-Italic': require('../assets/fonts/IBMPlexMono-Italic.ttf'),
                'IBMPlexMono-SemiBold': require('../assets/fonts/IBMPlexMono-SemiBold.ttf'),
                
                // Bricolage Grotesque
                'BricolageGrotesque-Bold': require('../assets/fonts/BricolageGrotesque-Bold.ttf'),
                
                ...FontAwesome.font,
            });
            const credentials = await TokenStorage.getCredentials();
            setInitState({ credentials });
        })();
    }, []);

    React.useEffect(() => {
        if (initState) {
            setTimeout(() => {
                SplashScreen.hideAsync();
            }, 100);
        }
    }, [initState]);

    if (!initState) {
        return null;
    }

    return (
        <KeyboardProvider>
            <AuthProvider initialCredentials={initState.credentials}>
                <DebugProvider>
                <ThemeProvider value={DefaultTheme}>
                    <Stack
                        initialRouteName='index'
                        screenOptions={{
                            headerShadowVisible: false,
                            contentStyle: {
                                backgroundColor: 'white',
                            },
                            headerStyle: {
                                backgroundColor: 'white',
                            },
                            headerTintColor: '#000',
                            headerTitleStyle: {
                                color: '#000',
                            },
                        }}
                    >
                        <Stack.Screen
                            name="index"
                            options={{
                                headerShown: true,
                                headerTitle: () => (
                                    <Text useDefaultTypography={false} style={{ fontSize: 24, color: '#000', ...Typography.logo() }}>
                                        Happy Coder
                                    </Text>
                                )
                            }}
                        />
                        <Stack.Screen
                            name="about"
                            options={{
                                presentation: 'modal',
                                headerShown: false,
                            }}
                        />
                        <Stack.Screen
                            name="manual-entry"
                            options={{
                                presentation: 'modal',
                                headerShown: false,
                            }}
                        />
                        <Stack.Screen
                            name="session/[id]"
                            options={{
                                headerTitle: 'Session',
                                headerBackTitle: 'Home'
                            }}
                        />
                        <Stack.Screen
                            name="session/[id]/message/[messageId]"
                            options={{
                                presentation: 'modal',
                                headerShown: false,
                            }}
                        />
                        <Stack.Screen
                            name="account"
                        />
                        <Stack.Screen
                            name="restore"
                            options={{
                                presentation: 'modal',
                                headerShown: false,
                            }}
                        />
                    </Stack>
                </ThemeProvider>
                </DebugProvider>
            </AuthProvider>
        </KeyboardProvider>
    );
}
