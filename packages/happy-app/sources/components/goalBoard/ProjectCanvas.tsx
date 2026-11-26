import type { ReactNode } from 'react';
import type { ProjectCanvasGeneratedResult } from './projectCanvasGeneratedImages';

export interface ProjectCanvasWorkspaceProps {
    machineId: string;
    projectPath: string;
    files: ReactNode;
    fileViewer?: ReactNode;
    showFile: boolean;
    fileMaximized: boolean;
    compactPane?: 'work' | 'tools' | 'chat';
    onSelectSurface: (surface: 'canvas' | 'file') => void;
}

export interface ProjectCanvasProps extends ProjectCanvasWorkspaceProps {
    onReference?: (file: File, asset: { id: string; versionId: string }) => Promise<void> | void;
    generatedResults?: readonly ProjectCanvasGeneratedResult[];
    readGeneratedResult?: (ref: string, signal: AbortSignal) => Promise<File>;
}

export function ProjectCanvas(_props: ProjectCanvasProps) {
    return null;
}

export function getProjectCanvasFramePath(): string | undefined {
    return undefined;
}
