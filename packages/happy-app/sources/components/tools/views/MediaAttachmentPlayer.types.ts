export type MediaAttachmentPlayerProps = {
    uri: string;
    headers: Record<string, string>;
    title: string;
    kind: 'audio' | 'video';
    mimeType: string;
    testID: string;
    posterUri?: string;
    aspectRatio?: number;
};
