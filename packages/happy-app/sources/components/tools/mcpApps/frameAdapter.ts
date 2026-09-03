import * as React from 'react';
import { Platform } from 'react-native';
import {
    createMcpAppFrameAdapter as createNativeMcpAppFrameAdapter,
    McpAppFrameView as NativeMcpAppFrameView,
} from './NativeMcpAppFrameAdapter';
import {
    createWebMcpAppFrameAdapter,
    WebMcpAppFrameView,
} from './WebMcpAppFrameAdapter';
import {
    createUnsupportedMcpAppFrameAdapter,
    McpAppFrameView as UnsupportedMcpAppFrameView,
} from './UnsupportedMcpAppFrameAdapter';
import type { McpAppFrameAdapter } from './types';

export type McpAppFrameAdapterChoice = {
    adapter: McpAppFrameAdapter;
    View: React.ComponentType<{ adapter: any }>;
};

type PlatformFactories = {
    native(): McpAppFrameAdapterChoice;
    web(): McpAppFrameAdapterChoice;
    unsupported(): McpAppFrameAdapterChoice;
};

const defaultFactories: PlatformFactories = {
    native: () => ({ adapter: createNativeMcpAppFrameAdapter(), View: NativeMcpAppFrameView }),
    web: () => ({ adapter: createWebMcpAppFrameAdapter(), View: WebMcpAppFrameView }),
    unsupported: () => ({ adapter: createUnsupportedMcpAppFrameAdapter(), View: UnsupportedMcpAppFrameView }),
};

export function selectMcpAppFrameAdapter(
    platform: string,
    factories: PlatformFactories = defaultFactories,
): McpAppFrameAdapterChoice {
    if (platform === 'web') return factories.web();
    if (platform === 'android' || platform === 'ios') return factories.native();
    return factories.unsupported();
}

export function createMcpAppFrameAdapter(): McpAppFrameAdapter {
    return selectMcpAppFrameAdapter(Platform.OS).adapter;
}

export function McpAppFrameView({ adapter }: { adapter: McpAppFrameAdapter }) {
    const { View } = selectMcpAppFrameAdapter(Platform.OS, {
        native: () => ({ adapter, View: NativeMcpAppFrameView }),
        web: () => ({ adapter, View: WebMcpAppFrameView }),
        unsupported: () => ({ adapter, View: UnsupportedMcpAppFrameView }),
    });
    return React.createElement(View, { adapter });
}
