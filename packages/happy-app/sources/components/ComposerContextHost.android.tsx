import * as React from 'react';
import { View } from 'react-native';
import type { ComposerContextHostProps } from './ComposerContextHost';
import { NativeComposerSelectorSheet } from './NativeComposerSelectorSheet';
import { layout } from './layout';

export function ComposerContextHost({ children, fromButton, onClose }: ComposerContextHostProps) {
    // @ suggestions must keep the original TextInput focused. The explicit Add
    // menu needs a native window: Android cannot hit-test an inline popup drawn
    // outside the composer's ancestor bounds, even when overflow is visible.
    if (!fromButton) return <>{children}</>;
    return <NativeComposerSelectorSheet open onClose={onClose} scrimTestID="composer-context-picker-scrim">
        <View style={{ width: '100%', maxWidth: layout.maxWidth, maxHeight: '100%', flexShrink: 1 }}>
            {children}
        </View>
    </NativeComposerSelectorSheet>;
}
