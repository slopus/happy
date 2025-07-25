import { Stack } from 'expo-router';

export default function DevLayout() {
    return (
        <Stack
            screenOptions={{
                headerBackTitle: 'Dev',
                headerShadowVisible: false,
                contentStyle: {
                    backgroundColor: '#F2F2F7',
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
                    headerTitle: 'Developer Tools',
                }}
            />
            <Stack.Screen
                name="list-demo"
                options={{
                    headerTitle: 'List Components Demo',
                }}
            />
            <Stack.Screen
                name="typography"
                options={{
                    headerTitle: 'Typography',
                }}
            />
            <Stack.Screen
                name="colors"
                options={{
                    headerTitle: 'Colors',
                }}
            />
            <Stack.Screen
                name="tools2"
                options={{
                    headerTitle: 'Tool Views Demo',
                }}
            />
            <Stack.Screen
                name="masked-progress"
                options={{
                    headerTitle: 'Masked Progress',
                }}
            />
            <Stack.Screen
                name="shimmer-demo"
                options={{
                    headerTitle: 'Shimmer View Demo',
                }}
            />
        </Stack>
    );
}