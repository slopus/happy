import axios from 'axios';

interface DownloadedImage {
    base64: string;
    mimeType: string;
}

/**
 * Downloads an image from URL and returns it as base64.
 */
export async function downloadImage(url: string): Promise<DownloadedImage> {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
    });

    const buffer = Buffer.from(response.data);
    const base64 = buffer.toString('base64');

    // Determine mime type from response headers or URL
    let mimeType = response.headers['content-type'] || 'image/jpeg';
    if (mimeType.includes(';')) {
        mimeType = mimeType.split(';')[0].trim();
    }

    return { base64, mimeType };
}
