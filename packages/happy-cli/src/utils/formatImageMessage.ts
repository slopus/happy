import { ImageContent } from '@/api/types';
import { downloadImage } from './downloadImage';

/**
 * Claude API content block types for mixed content messages
 */
export type ClaudeTextContent = {
    type: 'text';
    text: string;
};

export type ClaudeImageContent = {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
};

export type ClaudeContent = ClaudeTextContent | ClaudeImageContent;

/**
 * Formats a message with optional images into Claude API format.
 * Downloads images from URLs and converts them to base64.
 *
 * @param text - The text content of the message
 * @param images - Array of image content objects with URLs
 * @returns Array of Claude content blocks (text and images)
 */
export async function formatMessageForClaude(
    text: string,
    images: ImageContent[]
): Promise<ClaudeContent[]> {
    const content: ClaudeContent[] = [];

    // Add images first (Claude expects images before text for best results)
    for (const image of images) {
        const downloaded = await downloadImage(image.url);
        content.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: downloaded.mimeType,
                data: downloaded.base64,
            },
        });
    }

    // Add text content
    if (text.trim()) {
        content.push({
            type: 'text',
            text: text,
        });
    }

    return content;
}

/**
 * Gemini API part types for mixed content messages
 */
export type GeminiPart = {
    text?: string;
    inlineData?: {
        mimeType: string;
        data: string;
    };
};

export type GeminiContent = {
    parts: GeminiPart[];
};

/**
 * Formats a message with optional images into Gemini API format.
 * Downloads images from URLs and converts them to base64.
 *
 * @param text - The text content of the message
 * @param images - Array of image content objects with URLs
 * @returns Gemini content object with parts array (images first, then text)
 */
export async function formatMessageForGemini(
    text: string,
    images: ImageContent[]
): Promise<GeminiContent> {
    const parts: GeminiPart[] = [];

    // Add images first (images before text for best results)
    for (const image of images) {
        const downloaded = await downloadImage(image.url);
        parts.push({
            inlineData: {
                mimeType: downloaded.mimeType,
                data: downloaded.base64,
            },
        });
    }

    // Add text content
    if (text.trim()) {
        parts.push({
            text: text,
        });
    }

    return { parts };
}

/**
 * Codex/GPT API content block types for mixed content messages
 */
export type CodexTextContent = {
    type: 'text';
    text: string;
};

export type CodexImageContent = {
    type: 'image_url';
    image_url: {
        url: string;
    };
};

export type CodexContent = CodexTextContent | CodexImageContent;

/**
 * Formats a message with optional images into Codex/GPT API format.
 * Downloads images from URLs and converts them to base64 data URLs.
 *
 * @param text - The text content of the message
 * @param images - Array of image content objects with URLs
 * @returns Array of Codex content blocks (images first, then text)
 */
export async function formatMessageForCodex(
    text: string,
    images: ImageContent[]
): Promise<CodexContent[]> {
    const content: CodexContent[] = [];

    // Add images first (images before text for best results)
    for (const image of images) {
        const downloaded = await downloadImage(image.url);
        content.push({
            type: 'image_url',
            image_url: {
                url: `data:${downloaded.mimeType};base64,${downloaded.base64}`,
            },
        });
    }

    // Add text content
    if (text.trim()) {
        content.push({
            type: 'text',
            text: text,
        });
    }

    return content;
}
