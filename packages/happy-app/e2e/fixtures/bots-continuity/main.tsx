import React from 'react';
import { createRoot } from 'react-dom/client';
import { NavigationContainer, createNavigationContainerRef, createNavigatorFactory } from '@react-navigation/native';
import { DesktopStackNavigator } from '../../../sources/components/DesktopAppStack';
import { BotsScreen } from '../../../sources/components/bots/BotsScreen';
const { Navigator, Screen } = createNavigatorFactory(DesktopStackNavigator)();
const navigation = createNavigationContainerRef();
const Empty = () => <div>Other workspace</div>;
(globalThis as any).__stats = { launches: 0, mounts: 0, disposals: 0 };
window.fetch = async () => {
    (globalThis as any).__stats.launches++;
    return new Response(JSON.stringify({ runtimeUrl: 'https://bots.example/', ticket: 't'.repeat(43), expiresAt: Date.now()+60_000 }));
};
createRoot(document.getElementById('root')!).render(<>
    <nav><button onClick={() => navigation.navigate('bots' as never)}>Bots</button><button onClick={() => navigation.navigate('index' as never)}>Home</button><button onClick={() => navigation.reset({ index: 0, routes: [{ name: 'index' }] })}>Remove Bots route</button></nav>
    <div style={{ position: 'relative', flex: 1 }}><NavigationContainer ref={navigation}><Navigator initialRouteName="index" screenOptions={{headerShown:false}}><Screen name="index" component={Empty}/><Screen name="bots" component={BotsScreen}/></Navigator></NavigationContainer></div>
</>);
