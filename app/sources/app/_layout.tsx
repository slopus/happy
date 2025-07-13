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
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

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
      <Ionicons name="information-circle-outline" size={24} color="#000" />
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
        SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
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
    <AuthProvider initialCredentials={initState.credentials}>
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
              headerTitle: 'Happy Coder',
              headerRight: () => <HeaderRight />,
              headerBackTitle: 'Home'
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
            name="[session]"
            options={{
                
            }}
          />
        </Stack>
      </ThemeProvider>
    </AuthProvider>
  );
}
