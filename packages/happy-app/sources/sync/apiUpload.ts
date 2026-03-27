import { getServerUrl } from "@/sync/serverConfig";
import type { AuthCredentials } from "@/auth/tokenStorage";
import type { ImagePickerAsset } from "expo-image-picker";

const UPLOAD_ROUTE = "avatarUpload";

/**
 * Uploads a user avatar directly to Cloudflare R2 using a presigned URL
 * issued by the server.
 *
 * Flow:
 *  1. Request a presigned upload URL from the server (POST /v1/upload?action=presign)
 *  2. PUT the image bytes straight to R2 — the file never transits the server
 *  3. Notify the server that the upload finished (POST /v1/upload?action=complete)
 *     which triggers thumbhash generation and the account avatar update
 */
export async function uploadAvatar(
    credentials: AuthCredentials,
    asset: ImagePickerAsset
): Promise<void> {
    const serverUrl = getServerUrl();
    const endpoint = `${serverUrl}/v1/upload`;
    const authHeader = `Bearer ${credentials.token}`;

    const fileName = asset.fileName ?? `avatar.${asset.mimeType === "image/png" ? "png" : "jpg"}`;
    const mimeType = asset.mimeType ?? "image/jpeg";
    const fileSize = asset.fileSize ?? 0;

    // ── Step 1: Request a presigned URL ──────────────────────────────────────
    const presignResponse = await fetch(
        `${endpoint}?route=${UPLOAD_ROUTE}&action=presign`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": authHeader,
            },
            body: JSON.stringify({
                files: [{ name: fileName, size: fileSize, type: mimeType }],
            }),
        }
    );

    if (!presignResponse.ok) {
        const err = await presignResponse.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error((err as { error?: string }).error ?? `Presign failed: ${presignResponse.status}`);
    }

    const presignData = await presignResponse.json() as {
        success: boolean;
        error?: string;
        results: Array<{
            success: boolean;
            presignedUrl: string;
            key: string;
            error?: string;
        }>;
    };

    if (!presignData.success || !presignData.results?.[0]?.success) {
        throw new Error(presignData.error ?? presignData.results?.[0]?.error ?? "Failed to get presigned URL");
    }

    const { presignedUrl, key } = presignData.results[0];

    // ── Step 2: Upload the image bytes directly to R2 ────────────────────────
    // React Native's fetch supports reading local file URIs as blobs.
    const fileResponse = await fetch(asset.uri);
    const blob = await fileResponse.blob();

    const uploadResponse = await fetch(presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: blob,
    });

    if (!uploadResponse.ok) {
        throw new Error(`R2 upload failed: ${uploadResponse.status}`);
    }

    // ── Step 3: Notify the server to finalise the avatar ─────────────────────
    // The server fetches the image from R2, generates the thumbhash with Sharp,
    // persists the file record, updates the account avatar, and emits a
    // real-time socket update to all connected clients.
    const completeResponse = await fetch(
        `${endpoint}?route=${UPLOAD_ROUTE}&action=complete`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": authHeader,
            },
            body: JSON.stringify({
                completions: [
                    {
                        key,
                        file: { name: fileName, size: fileSize, type: mimeType },
                    },
                ],
            }),
        }
    );

    if (!completeResponse.ok) {
        // The upload itself succeeded — only the DB record and socket update failed.
        // Log the error but don't surface it as a hard failure.
        const err = await completeResponse.json().catch(() => ({})) as Record<string, unknown>;
        console.error("Avatar finalisation failed:", err);
        throw new Error((err as { error?: string }).error ?? `Finalise failed: ${completeResponse.status}`);
    }
}
