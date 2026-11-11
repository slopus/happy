// Native retains its existing text-selection interaction. DOM annotation UI is Web-only.
import type { FileReference } from '../fileWorkspace/context';
import type { ReactNode } from 'react';
import { EMPTY_ANNOTATIONS, type MessageAnnotation } from './annotationDraft';
export type AnnotationSourceProps = { sessionId?: string; messageId: string; enabled: boolean; children: ReactNode };
export type FileAnnotationSourceProps = { sessionId?: string; file: FileReference | null; children: ReactNode };
export function AnnotatableFile({ children }: FileAnnotationSourceProps) { return <>{children}</>; }
export type AnnotationComposerProps = { sessionId: string };
export function AnnotatableMessage({ children }: AnnotationSourceProps) { return <>{children}</>; }
export function AnnotationComposer(_props: AnnotationComposerProps) { return null; }
export function useMessageAnnotations(_sessionId: string) { return EMPTY_ANNOTATIONS; }
export function prepareAnnotatedMessage(_sessionId: string, text: string) { return { text, displayText: text, annotations: EMPTY_ANNOTATIONS, commit: () => {} }; }

export function restoreAnnotatedMessage(_sessionId: string, _annotations: readonly MessageAnnotation[]) {}

export function FileAnnotationControls(_props: { sessionId: string; enabled: boolean }) { return null; }
export function FileAnnotationHint(_props: { sessionId: string }) { return null; }
export function FileAnnotationPanel(_props: { sessionId: string; compact?: boolean; showPreview?: (path: string) => void }) { return null; }
