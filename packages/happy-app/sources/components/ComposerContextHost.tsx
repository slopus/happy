import * as React from 'react';
import type { View } from 'react-native';
export function ComposerContextHost({ children }: { children: React.ReactNode; anchorRef: React.RefObject<View | null> }) { return <>{children}</>; }
