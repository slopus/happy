/** Build headers for either a presigned OSS PUT or an authenticated local PUT. */
export function mediaUploadHeaders(
    uploadUrl: string,
    mimeType: string,
    token: string,
): Record<string, string> {
    const isPresignedObjectUrl = /[?&](X-Amz-Algorithm|X-Amz-Signature|X-Amz-Credential|Signature|Expires)=/i.test(uploadUrl);
    return isPresignedObjectUrl
        ? { 'Content-Type': mimeType }
        : {
            'Content-Type': 'application/octet-stream',
            Authorization: `Bearer ${token}`,
        };
}
