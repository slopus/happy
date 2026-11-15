import { useEffect, useRef } from "react";

export type PendingAttachmentPreview = {
  previewUrl?: string;
};

export function isFileDrag(dataTransfer: Pick<DataTransfer, "types" | "items"> | null): boolean {
  if (!dataTransfer) return false;
  return (
    Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items).some((item) => item.kind === "file")
  );
}

export function isFilePaste(
  clipboardData: Pick<DataTransfer, "files" | "items"> | null | undefined,
): boolean {
  if (!clipboardData) return false;
  // Require a non-empty FileList. Some browsers advertise file-kind items with
  // an empty files list; those must not intercept native text paste.
  return (clipboardData.files?.length ?? 0) > 0;
}

export function revokePendingAttachmentPreviews(
  attachments: readonly PendingAttachmentPreview[],
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? (result.split(",")[1] ?? "") : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Release the latest previews when the shell leaves, including space remounts. */
export function usePendingAttachmentPreviewCleanup(
  attachments: readonly PendingAttachmentPreview[],
): void {
  const latest = useRef(attachments);
  latest.current = attachments;
  useEffect(() => () => revokePendingAttachmentPreviews(latest.current), []);
}
