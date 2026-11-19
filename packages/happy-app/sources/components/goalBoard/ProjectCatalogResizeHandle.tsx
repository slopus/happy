import * as React from 'react';
import { View } from 'react-native';
import { projectPanelGap } from './projectWorkspaceLayout';

export type ProjectCatalogResizeHandleProps = {
    width: number;
    rowWidth: number;
    rightWidth: number;
    onResize: (width: number | undefined) => void;
};

// Preserve the existing gap on platforms without a mouse-driven split view.
export function ProjectCatalogResizeHandle(_props: ProjectCatalogResizeHandleProps) {
    return <View style={{ width: projectPanelGap, flexShrink: 0 }} />;
}
