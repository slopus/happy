// Native retains its existing text-selection interaction. DOM annotation UI is Web-only.
import type { ReactNode } from 'react';
import { EMPTY_ANNOTATIONS } from './annotationDraft';
export type AnnotationSourceProps = { sessionId?: string; messageId: string; enabled: boolean; children: ReactNode };
export type AnnotationComposerProps = { sessionId: string };
export function AnnotatableMessage({ children }: AnnotationSourceProps) { return <>{children}</>; }
export function AnnotationComposer(_props: AnnotationComposerProps) { return null; }
export function useMessageAnnotations(_sessionId: string) { return EMPTY_ANNOTATIONS; }
export function prepareAnnotatedMessage(_sessionId: string, text: string) { return { text, commit: () => {} }; }
