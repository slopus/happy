interface FileContentLike {
    content: string;
}

interface SelectSharePayloadInput {
    platform: string;
    imageBase64: string | null;
    imageMimeType: string;
    fileContent: FileContentLike | null;
    diffContent: string | null;
}

export type FileViewerSharePayload =
    | { kind: 'image'; base64: string; mimeType: string }
    | { kind: 'text'; text: string }
    | { kind: 'none' };

export function selectFileViewerSharePayload(input: SelectSharePayloadInput): FileViewerSharePayload {
    if (input.platform !== 'web' && input.imageBase64) {
        return { kind: 'image', base64: input.imageBase64, mimeType: input.imageMimeType };
    }

    const textContent = input.fileContent?.content || input.diffContent || '';
    if (textContent) {
        return { kind: 'text', text: textContent };
    }

    return { kind: 'none' };
}
