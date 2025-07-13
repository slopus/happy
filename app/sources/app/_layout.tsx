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

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'home',
};

// Configure splash screen
SplashScreen.setOptions({
  fade: true,
  duration: 300,
})
SplashScreen.preventAutoHideAsync();

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
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack
          initialRouteName='home'
          screenOptions={{
            headerShadowVisible: false,
            contentStyle: {
              backgroundColor: 'white',
            }
          }}
        >
          <Stack.Screen
            name="home"
            options={{
              headerShown: true,
              headerTitle: 'Handy Coder',
            }}
          />
        </Stack>
      </ThemeProvider>
    </AuthProvider>
  );
}
