import type { ReactNode } from 'react';
import type { ProjectCanvasGeneratedResult } from './projectCanvasGeneratedImages';
import type { CanvasReviewAttachmentContext } from '@/sync/attachmentTypes';

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
    review?: { scope: string; marks: CanvasReviewAttachmentContext[]; capacity: number; nextNumber: number };
    onReviewMark?: (file: File, context: CanvasReviewAttachmentContext, signal: AbortSignal, expiresAt: number) => Promise<void>;
}

export function ProjectCanvas(_props: ProjectCanvasProps) {
    return null;
}

export function getProjectCanvasFramePath(): string | undefined {
    return undefined;
}
