import * as React from 'react';
import type { View } from 'react-native';

export type ComposerContextHostProps = React.PropsWithChildren<{
    anchorRef: React.RefObject<View | null>;
    fromButton: boolean;
    onClose: () => void;
}>;

export function ComposerContextHost({ children }: ComposerContextHostProps) { return <>{children}</>; }
