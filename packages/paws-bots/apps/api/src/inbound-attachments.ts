import type { MessagingInboundAttachment } from "@rakazo/adapter-kit";
import { isAttachmentAudioMimeType } from "@rakazo/contracts";
import { sanitizeMessagingLabel } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

type InboundArtifact = { id: string; name: string; mimeType: string; size: number };

/** Stores a platform file (Telegram photo, Slack upload, voice note, …) as a thread artifact. */
export type InboundAttachmentStore = (input: {
  spaceId: string;
  userId: string;
  botId: string;
  attachment: MessagingInboundAttachment;
  clientNonce: string;
  downloadDeadline?: number;
}) => Promise<
  InboundArtifact & {
    /** Downloaded content; absent when a replayed delivery returned a stored row. */
    bytes?: Uint8Array;
  }
>;

/**
 * Stores inbound files in order. Files past `limit`, or that the store rejects, become
 * `[file: name (unavailable)]` lines; the sender controls the name, so it is sanitized
 * before it can reach a prompt. The store enforces the download deadline itself, after
 * looking up a file a replayed delivery already saved. Only audio keeps its bytes.
 */
export async function storeInboundAttachments(
  store: InboundAttachmentStore | undefined,
  owner: { spaceId: string; userId: string; botId: string },
  attachments: MessagingInboundAttachment[],
  options: { clientNonce: (index: number) => string; limit: number; downloadDeadline?: number },
) {
  const stored: Array<{ artifact: InboundArtifact; bytes: Uint8Array | undefined }> = [];
  const unavailable: string[] = [];
  const { downloadDeadline } = options;
  for (const [index, attachment] of attachments.entries()) {
    const label = `[file: ${sanitizeMessagingLabel(attachment.name)} (unavailable)]`;
    if (!store || index >= options.limit) {
      unavailable.push(label);
      continue;
    }
    try {
      const { bytes, ...artifact } = await store({
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        attachment,
        clientNonce: options.clientNonce(index),
        ...(downloadDeadline !== undefined ? { downloadDeadline } : {}),
      });
      stored.push({
        artifact,
        bytes: isAttachmentAudioMimeType(artifact.mimeType) ? bytes : undefined,
      });
    } catch (error) {
      getLogger().warn("inbound attachment was not stored", {
        reason: error instanceof Error ? error.message : String(error),
      });
      unavailable.push(label);
    }
  }
  return { stored, unavailable };
}
