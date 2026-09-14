import { z } from "zod";
import { encodeBase64 } from "@/encryption/base64";
import { decryptBlob } from "@/encryption/blob";
import type { AuthCredentials } from "@/auth/tokenStorage";
import type { Encryption } from "./encryption/encryption";
import type { ProjectAvatar } from "./projectTypes";
import type { SessionAvatarDescriptor } from "./sessionAvatarTypes";
import { getHappyClientId } from "./apiSocket";
import { getServerUrl, rewriteLoopbackHost } from "./serverConfig";

const previewSchema = z.object({
  thumbhash: z.string().min(4).max(128),
  mimeType: z.enum(["image/webp", "image/png", "image/jpeg"]),
});
const downloadSchema = z.object({ ref: z.string(), downloadUrl: z.string().url() });
const MAX_BYTES = 10 * 1024 * 1024;

/** The descriptor is opaque; only session encryption can turn it into display data. */
export async function loadSessionAvatar(
  credentials: AuthCredentials,
  encryption: Pick<Encryption, "getSessionEncryption" | "getSessionBlobKey">,
  sessionId: string,
  descriptor: SessionAvatarDescriptor,
  signal: AbortSignal,
): Promise<ProjectAvatar | null> {
  const session = encryption.getSessionEncryption(sessionId);
  const key = encryption.getSessionBlobKey(sessionId);
  if (!session || !key) return null;
  const preview = previewSchema.safeParse(await session.decryptRaw(descriptor.preview));
  if (!preview.success || signal.aborted) return null;
  const serverUrl = getServerUrl();
  const headers = {
    Authorization: `Bearer ${credentials.token}`,
    "X-Happy-Client": getHappyClientId(),
  };
  const grant = await fetch(
    `${serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/avatar/request-download`,
    {
      method: "POST",
      headers,
      signal,
      redirect: "error",
    },
  );
  if (!grant.ok) return null;
  const download = downloadSchema.safeParse(await grant.json());
  // A replacement may have happened since the descriptor was received.
  if (!download.success || download.data.ref !== descriptor.ref) return null;
  const url = new URL(rewriteLoopbackHost(download.data.downloadUrl));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  const response = await fetch(url.toString(), {
    headers: url.origin === new URL(serverUrl).origin ? headers : undefined,
    signal,
    redirect: "error",
  });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) return null;
  const encrypted = new Uint8Array(await response.arrayBuffer());
  if (encrypted.byteLength > MAX_BYTES || signal.aborted) return null;
  const bytes = decryptBlob(encrypted, key);
  if (!bytes || signal.aborted) return null;
  return {
    ref: descriptor.ref,
    version: descriptor.version,
    ...preview.data,
    uri: `data:${preview.data.mimeType};base64,${encodeBase64(bytes)}`,
  };
}
