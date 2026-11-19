import * as React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { WebModalBackdropProps } from './WebModalBackdrop';

/** Sibling backdrop: clicks inside the dialog cannot bubble into this target. */
export function WebModalBackdrop({ onClose, testID }: WebModalBackdropProps) {
    return <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={onClose} testID={testID} />;
}
