import * as React from 'react';
import { Platform } from 'react-native';
import type { View } from 'react-native';
import { generateThumbhash } from '@/utils/thumbhash';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

// One drop event must be taken by at most one composer, and every mounted
// composer has to be able to tell whether a document-level event is its own.
// Both registries are module-level so all composers share them.
const claimedDropEvents = new WeakSet<DragEvent>();
const mountedComposerNodes = new Set<HTMLElement>();

/**
 * Web-only: intercept image clipboard pastes and file drops anywhere in the
 * document and funnel them into an attachment handler.
 *
 * Why a document-level listener (not an element handler): React Native Web's
 * text input doesn't surface raw `paste`/`drop` clipboard files, so we listen
 * on `document`. Several composers can be mounted at once (stacked session
 * screens, side chats, the new-session screen), so each one registers its own
 * field node and decides whether an event belongs to it — otherwise one paste
 * or drop lands in every mounted composer.
 *
 * `composerFieldRef` should point at the View wrapping the composer's text
 * input. Shared by AgentInput (in-session composer) and the new-session
 * composer so both get identical paste/drag behavior. No-op on native and when
 * no handler is provided.
 */
export function useWebImagePaste(
    onAddImages?: (images: AttachmentPreview[]) => void,
    composerFieldRef?: { current: View | null },
) {
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !onAddImages) return;

        const composerNode = () => (composerFieldRef?.current ?? null) as unknown as HTMLElement | null;
        const node = composerNode();
        if (node) mountedComposerNodes.add(node);

        const isEditable = (element: Element | null) => element instanceof HTMLInputElement
            || element instanceof HTMLTextAreaElement
            || (element instanceof HTMLElement && element.isContentEditable);
        const isEditableTarget = (target: EventTarget | null) => {
            if (!(target instanceof Element)) return false;
            return isEditable(target)
                || !!target.closest('input,textarea,[contenteditable="true"]');
        };
        const ownsFocus = () => {
            const currentNode = composerNode();
            const active = document.activeElement;
            return !!currentNode
                && currentNode.getClientRects().length > 0
                && isEditable(active)
                && currentNode.contains(active);
        };

        const handlePaste = async (e: ClipboardEvent) => {
            // Only a paste into this composer's own input. Without the guard a
            // paste in the URL bar, a modal, or a sibling composer's input
            // would steal images intended for somewhere else.
            if (!ownsFocus()) return;

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
        // `types.includes('Files')` so we don't hijack drag-text/HTML in the
        // rest of the app.
        const isFileDrag = (e: DragEvent) => {
            const types = e.dataTransfer?.types;
            if (!types) return false;
            // DataTransferItemList vs DOMStringList — both expose .includes-ish.
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
            // The drop is ours when it lands on this visible composer, when
            // this composer owns the focus, or when no editable is focused and
            // this is the only visible composer. With multiple visible side
            // chats an untargeted drop is intentionally ignored; the
            // mounted-node registry still routes targeted drops to the sibling
            // they landed on.
            const currentNode = composerNode();
            const target = e.target;
            const targetComposer = target instanceof Node
                ? [...mountedComposerNodes].find((candidate) => candidate.contains(target))
                : undefined;
            const visibleComposers = [...mountedComposerNodes]
                .filter((candidate) => candidate.getClientRects().length > 0);
            const targetIsThisComposer = !!currentNode
                && targetComposer === currentNode
                && currentNode.getClientRects().length > 0;
            const targetIsAnotherComposer = !!targetComposer && targetComposer !== currentNode;
            const targetIsOutsideEditable = isEditableTarget(target) && !targetIsThisComposer;
            const takesDrop = !targetIsAnotherComposer
                && !targetIsOutsideEditable
                && (targetIsThisComposer
                    || ownsFocus()
                    || (!isEditable(document.activeElement)
                        && !!currentNode
                        && visibleComposers.length === 1
                        && visibleComposers[0] === currentNode));
            if (!takesDrop || claimedDropEvents.has(e)) return;
            claimedDropEvents.add(e);
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
            if (node) mountedComposerNodes.delete(node);
            document.removeEventListener('paste', handlePaste as any);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
        };
    }, [onAddImages, composerFieldRef]);
}
