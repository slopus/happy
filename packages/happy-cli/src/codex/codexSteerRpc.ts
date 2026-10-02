import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { createHash, randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import type { CodexAppServerClient } from './codexAppServerClient';
import { detectCodexImage, materializeCodexImageItems } from './codexImageInput';
import type { ImageAttachment } from '@/utils/MessageQueue2';

export type CodexSteerRequest = {
    text: string;
    expectedTurnId: string;
    clientMessageId: string;
    images?: Array<{ data: string; mimeType?: string; name?: string }>;
};
export type CodexSteerResponse = { accepted: true; turnId: string; clientMessageId: string };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;

/** Bound and validate all bytes before materialization; never silently drop an upload. */
export function decodeCodexSteerImages(images: CodexSteerRequest['images']): ImageAttachment[] {
    if (images === undefined) return [];
    if (!Array.isArray(images) || images.length > 10) throw new Error('At most 10 steering images are supported.');
    let total = 0;
    return images.map((image) => {
        if (!image || typeof image.data !== 'string' || !image.data.length
            || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
            throw new Error('Invalid or oversized steering image.');
        }
        const data = Buffer.from(image.data, 'base64');
        if (data.toString('base64') !== image.data) throw new Error('Invalid steering image encoding.');
        total += data.length;
        const detected = detectCodexImage(data);
        if (!detected || data.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES) {
            throw new Error('Steering images must be PNG, JPEG, GIF or WebP within the upload size limit.');
        }
        return { data, mimeType: detected.mime, name: typeof image.name === 'string' ? image.name.slice(0, 128) : 'image' };
    });
}

export function createCodexSteerHandler(options: {
    client: Pick<CodexAppServerClient, 'steerTurn'>;
    sendMessage: (envelope: SessionEnvelope) => void;
    uploadImageAttachment?: ApiSessionClient['uploadImageAttachment'];
}) {
    // Keep confirmed and in-flight requests idempotent across transport retries.
    const requests = new Map<string, { signature: string; promise: Promise<CodexSteerResponse> }>();
    return async (request: CodexSteerRequest): Promise<CodexSteerResponse> => {
        if (!request || typeof request.text !== 'string' || request.text.length > 1_000_000
            || typeof request.expectedTurnId !== 'string' || !request.expectedTurnId
            || typeof request.clientMessageId !== 'string' || !request.clientMessageId || request.clientMessageId.length > 256) {
            throw new Error('Invalid Codex steering request.');
        }
        const signature = createHash('sha256').update(JSON.stringify(request)).digest('hex');
        const existing = requests.get(request.clientMessageId);
        if (existing) {
            if (existing.signature !== signature) throw new Error('A steering message ID cannot be reused with different input.');
            return existing.promise;
        }
        const attachments = decodeCodexSteerImages(request.images);
        if (!request.text.trim() && !attachments.length) throw new Error('Steering input must not be empty.');
        const promise = (async (): Promise<CodexSteerResponse> => {
            const images = materializeCodexImageItems(attachments, randomUUID());
            if (images.length !== attachments.length) throw new Error('Could not prepare every steering image. Your message remains queued.');
            if (images.length > 0 && !options.uploadImageAttachment) {
                throw new Error('Steering image history upload is unavailable. Your message remains queued.');
            }
            // Upload before submitting so failed uploads cannot lose accepted visual context.
            const uploadedImages = [];
            for (const image of images) {
                uploadedImages.push(await options.uploadImageAttachment!(image.path));
            }
            const { turnId } = await options.client.steerTurn(request.text, request.expectedTurnId, images, request.clientMessageId);
            uploadedImages.forEach((image, index) => {
                options.sendMessage(createEnvelope('user', {
                    t: 'file', ref: image.ref, name: image.name, size: image.size,
                    mimeType: attachments[index].mimeType, kind: 'image', source: 'user', encrypted: true,
                    ...(image.dims ? { image: { ...image.dims, thumbhash: '' } } : {}),
                    ...(image.motionPhoto ? { motionPhoto: image.motionPhoto } : {}),
                }, { id: `codex-steer:${request.clientMessageId}:image:${index}`, turn: turnId }));
            });
            options.sendMessage(createEnvelope('user', { t: 'text', text: request.text || 'Attached image' }, {
                id: `codex-steer:${request.clientMessageId}`, turn: turnId,
            }));
            return { accepted: true, turnId, clientMessageId: request.clientMessageId };
        })();
        requests.set(request.clientMessageId, { signature, promise });
        try {
            const result = await promise;
            // Never evict a request still awaiting its authoritative result.
            if (requests.size > 256) {
                for (const [id, entry] of requests) {
                    if (id !== request.clientMessageId) {
                        void entry.promise.then(() => { if (requests.size > 256) requests.delete(id); }, () => {});
                    }
                }
            }
            return result;
        } catch (error) {
            requests.delete(request.clientMessageId);
            throw error;
        }
    };
}
