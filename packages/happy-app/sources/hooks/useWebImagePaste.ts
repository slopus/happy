import * as React from 'react';
import { Platform } from 'react-native';
import { generateThumbhash } from '@/utils/thumbhash';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

/**
 * Web-only: intercept image clipboard pastes and file drops anywhere in the
 * document and funnel them into an attachment handler.
 *
 * Why a document-level listener (not an element handler): React Native Web's
 * text input doesn't surface raw `paste`/`drop` clipboard files, so we listen
 * on `document` and gate paste on a focused editable target — otherwise a paste
 * in the URL bar or another input would steal images meant for elsewhere.
 *
 * Shared by AgentInput (in-session composer) and the new-session composer so
 * both get identical paste/drag behavior. No-op on native and when no handler
 * is provided.
 */
export function useWebImagePaste(onAddImages?: (images: AttachmentPreview[]) => void) {
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !onAddImages) return;

        const handlePaste = async (e: ClipboardEvent) => {
            const active = document.activeElement;
            const isEditableTarget = active instanceof HTMLInputElement
                || active instanceof HTMLTextAreaElement
                || (active instanceof HTMLElement && active.isContentEditable);
            if (!isEditableTarget) return;

            const { getImagesFromClipboard, fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const files = getImagesFromClipboard(e);
            if (!files.length) return;
            e.preventDefault();
            const previews = (await Promise.all(
                files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
            )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
            if (previews.length) {
                onAddImages(previews.map((p) => ({
                    ...p,
                    id: `paste_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                })));
            }
        };

        // dragover must call preventDefault for drop to fire; we gate on
        // `types.includes('Files')` so we don't hijack drag-text/HTML elsewhere.
        const isFileDrag = (e: DragEvent) => {
            const types = e.dataTransfer?.types;
            if (!types) return false;
            for (let i = 0; i < types.length; i++) {
                if (types[i] === 'Files') return true;
            }
            return false;
        };

        const handleDragOver = (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };

        const handleDrop = async (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            const { getImagesFromDrop, fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const files = getImagesFromDrop(e);
            if (!files.length) return;
            const previews = (await Promise.all(
                files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
            )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
            if (previews.length) {
                onAddImages(previews.map((p) => ({
                    ...p,
                    id: `drop_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                })));
            }
        };

        document.addEventListener('paste', handlePaste as any);
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        return () => {
            document.removeEventListener('paste', handlePaste as any);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
        };
    }, [onAddImages]);
}
