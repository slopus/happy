import * as React from 'react';
import { act } from 'react';
import { expect, it } from 'vitest';
// @ts-expect-error no declarations
import TestRenderer from 'react-test-renderer';
import { BaseNavigationContainer, createNavigatorFactory, useNavigationBuilder } from '@react-navigation/core';
import { DrawerRouter, StackRouter } from '@react-navigation/routers';

const navigation: Record<string, any> = {};
function DrawerNavigator(props: any) {
    const built = useNavigationBuilder(DrawerRouter, props);
    navigation.drawer = built.navigation;
    return <built.NavigationContent>{built.state.routes.map(route => built.descriptors[route.key].render())}</built.NavigationContent>;
}
function StackNavigator(props: any) {
    const built = useNavigationBuilder(StackRouter, props);
    navigation.stack = built.navigation;
    return <built.NavigationContent>{built.state.routes.map(route => built.descriptors[route.key].render())}</built.NavigationContent>;
}
const Drawer = createNavigatorFactory(DrawerNavigator)();
const Stack = createNavigatorFactory(StackNavigator)();
function Empty() { return null; }
function App() { return <Stack.Navigator><Stack.Screen name="home" component={Empty} /><Stack.Screen name="conversation" component={Empty} /></Stack.Navigator>; }
function isOpen() { return navigation.drawer.getState().history.some((entry: any) => entry.type === 'drawer' && entry.status === 'open'); }
it('real nested navigation propagates focus and closes the drawer without an explicit callback', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<BaseNavigationContainer><Drawer.Navigator><Drawer.Screen name="app" component={App} /></Drawer.Navigator></BaseNavigationContainer>); });
    try {
        act(() => navigation.drawer.openDrawer());
        expect(isOpen()).toBe(true);
        act(() => navigation.stack.navigate('conversation'));
        expect(navigation.stack.getState().routes[navigation.stack.getState().index].name).toBe('conversation');
        expect(isOpen()).toBe(false);
        act(() => navigation.drawer.openDrawer());
        expect(isOpen()).toBe(true);
        act(() => navigation.stack.navigate('conversation'));
        expect(isOpen()).toBe(false);
    } finally { act(() => renderer.unmount()); }
});
