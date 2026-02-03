import { ImageContent } from '@/api/types';
import { downloadImage } from './downloadImage';

interface ClaudeImageContent {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
}

interface ClaudeTextContent {
    type: 'text';
    text: string;
}

export type ClaudeContent = ClaudeImageContent | ClaudeTextContent;

/**
 * Converts a mixed message with images to Claude SDK format.
 * Downloads images and converts them to base64.
 */
export async function formatMessageForClaude(
    text: string,
    images: ImageContent[]
): Promise<ClaudeContent[]> {
    const content: ClaudeContent[] = [];

    // Add images first
    for (const img of images) {
        const downloaded = await downloadImage(img.url);
        content.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: downloaded.mimeType,
                data: downloaded.base64,
            },
        });
    }

    // Add text
    if (text.trim()) {
        content.push({
            type: 'text',
            text,
        });
    }

    return content;
}

/**
 * Converts a mixed message to Gemini ACP format.
 */
export async function formatMessageForGemini(
    text: string,
    images: ImageContent[]
): Promise<{ parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> }> {
    const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [];

    // Add images first
    for (const img of images) {
        const downloaded = await downloadImage(img.url);
        parts.push({
            inlineData: {
                mimeType: downloaded.mimeType,
                data: downloaded.base64,
            },
        });
    }

    // Add text
    if (text.trim()) {
        parts.push({ text });
    }

    return { parts };
}

/**
 * Converts a mixed message to Codex/GPT format.
 */
export async function formatMessageForCodex(
    text: string,
    images: ImageContent[]
): Promise<Array<{ type: string; text?: string; image_url?: { url: string } }>> {
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    // Add images first
    for (const img of images) {
        const downloaded = await downloadImage(img.url);
        content.push({
            type: 'image_url',
            image_url: {
                url: `data:${downloaded.mimeType};base64,${downloaded.base64}`,
            },
        });
    }

    // Add text
    if (text.trim()) {
        content.push({
            type: 'text',
            text,
        });
    }

    return content;
}
