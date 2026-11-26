import * as React from 'react';
import { accountRuntimeCurrent, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { GOAL_CANVAS_LIMITS } from '@slopus/happy-wire';
import { decryptBlob } from '@/encryption/blob';
import { MAX_FILE_SIZE, MAX_IMAGES_PER_MESSAGE } from '@/hooks/useImagePicker';
import { useSessionAttachmentDraft } from '@/hooks/useSessionAttachmentDraft';
import { downloadEncryptedAttachment } from '@/sync/apiAttachments';
import { captureAttachmentContext } from '@/sync/attachmentCacheContext';
import { waitForAttachmentTransfer } from '@/sync/attachmentTransfer';
import { sync } from '@/sync/sync';
import { storage, useSessionMessages } from '@/sync/storage';
import { t } from '@/text';
import { detectSupportedImageMime } from '@/utils/detectSupportedImageMime';
import { fileToAttachmentPreview } from '@/utils/pasteImages.web';
import { generateThumbhash } from '@/utils/thumbhash';
import { ProjectCanvas } from './ProjectCanvas';
import type { ProjectCanvasConversationProps } from './ProjectCanvasConversation';
import { collectProjectCanvasGeneratedResults } from './projectCanvasGeneratedImages';

export function ProjectCanvasConversation({ sessionId, ...workspace }: ProjectCanvasConversationProps) {
    const { machineId, projectPath } = workspace;
    const account = getRuntimeAccountSelection();
    const setImages = useSessionAttachmentDraft(sessionId ?? '')?.setImages;
    const { messages, isAtLatest } = useSessionMessages(sessionId ?? '');
    const flavor = storage(state => sessionId ? state.sessions[sessionId]?.metadata?.flavor : undefined);
    const canAttach = !!sessionId && !!setImages && (!flavor || ['claude', 'codex', 'opencode'].includes(flavor));
    const scope = React.useMemo(() => ({ machineId, projectPath, sessionId, account }), [machineId, projectPath, sessionId, account]);
    const currentScope = React.useRef<typeof scope | null>(scope);
    React.useLayoutEffect(() => {
        currentScope.current = scope;
        return () => { currentScope.current = null; };
    }, [scope]);
    const generatedResults = React.useMemo(() => sessionId && isAtLatest
        ? collectProjectCanvasGeneratedResults(sessionId, messages) : [], [sessionId, isAtLatest, messages]);
    const currentResults = React.useRef(generatedResults);
    React.useLayoutEffect(() => { currentResults.current = generatedResults; }, [generatedResults]);

    const readGeneratedResult = React.useCallback(async (ref: string, signal: AbortSignal): Promise<File> => {
        function current() {
            signal.throwIfAborted();
            const result = currentResults.current.find(item => item.ref === ref);
            if (!result || currentScope.current !== scope || !accountRuntimeCurrent() || getRuntimeAccountSelection() !== account)
                throw new Error(t('projectCanvas.importError'));
            return result;
        }
        const result = current();
        const credentials = sync.getCredentials();
        if (!sessionId || !credentials) throw new Error(t('projectCanvas.importError'));
        const context = captureAttachmentContext(credentials, sessionId);
        const key = sync.encryption.getSessionBlobKey(sessionId);
        if (!key || key.length !== 32) throw new Error(t('projectCanvas.importError'));

        const encrypted = await waitForAttachmentTransfer(downloadEncryptedAttachment(credentials, sessionId, ref), signal);
        await context.assertCurrent();
        current();
        if (sync.getCredentials()?.token !== context.token) throw new Error(t('projectCanvas.importError'));
        const bytes = decryptBlob(encrypted, key);
        const mime = bytes && detectSupportedImageMime(bytes);
        if (!bytes || !mime || bytes.byteLength > GOAL_CANVAS_LIMITS.assetBytes)
            throw new Error(t('projectCanvas.importError'));
        return new File([new Uint8Array(bytes)], result.name, { type: mime });
    }, [account, scope, sessionId]);

    const reference = React.useCallback(async (file: File, asset: { id: string; versionId: string }) => {
        const isCurrent = () => currentScope.current === scope && accountRuntimeCurrent() && getRuntimeAccountSelection() === account;
        if (!canAttach || !setImages || !isCurrent() || file.size > MAX_FILE_SIZE) throw new Error(t('projectCanvas.referenceError'));
        const id = `project-canvas:${asset.id}:${asset.versionId}`;
        const preview = await fileToAttachmentPreview(file, generateThumbhash);
        if (!preview) throw new Error(t('projectCanvas.referenceError'));
        let full = false;
        setImages(current => {
            if (!isCurrent() || current.some(item => item.id === id) || current.length >= MAX_IMAGES_PER_MESSAGE) {
                full = current.length >= MAX_IMAGES_PER_MESSAGE && !current.some(item => item.id === id);
                URL.revokeObjectURL(preview.uri);
                return current;
            }
            return [...current, { ...preview, id }];
        });
        if (!isCurrent() || full) throw new Error(t('projectCanvas.referenceError'));
    }, [scope, account, canAttach, setImages]);

    return <ProjectCanvas {...workspace} onReference={canAttach ? reference : undefined}
        generatedResults={generatedResults} readGeneratedResult={readGeneratedResult} />;
}
