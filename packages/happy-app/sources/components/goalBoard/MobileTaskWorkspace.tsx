import * as React from 'react';
import { Platform, View } from 'react-native';

/** Auxiliary surfaces cover a measured conversation instead of unmounting or collapsing it. */
export function MobileTaskWorkspace({ view, chat, details, files, reader, menu }: {
    view: 'chat' | 'details' | 'files' | 'reader';
    chat: React.ReactNode; details: React.ReactNode; files: React.ReactNode;
    reader?: React.ReactNode; menu?: React.ReactNode;
}) {
    const hidden = view !== 'chat';
    const overlay = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };
    return <View style={{ flex: 1, minHeight: 0 }} testID="mobile-task-workspace">
        {menu}
        <View testID="mobile-task-conversation" style={[{ flex: 1, minHeight: 0, opacity: hidden ? 0 : 1 }, Platform.OS === 'web' && ({ visibility: hidden ? 'hidden' : 'visible' } as any)]} pointerEvents={hidden ? 'none' : 'auto'} accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}>{chat}</View>
        <View style={[overlay, view !== 'details' && { display: 'none' }]}>{details}</View>
        <View style={[overlay, view !== 'files' && { display: 'none' }]}>{files}</View>
        {view === 'reader' && <View style={overlay}>{reader}</View>}
    </View>;
}
