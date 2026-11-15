// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PendingAttachmentPreview } from "./pending-attachments";
import { usePendingAttachmentPreviewCleanup } from "./pending-attachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("revokes the latest pending previews when the shell unmounts", async () => {
  const revoke = vi.fn();
  vi.stubGlobal("URL", { revokeObjectURL: revoke });
  const root = createRoot(document.createElement("div"));
  function Shell({ attachments }: { attachments: PendingAttachmentPreview[] }) {
    usePendingAttachmentPreviewCleanup(attachments);
    return null;
  }
  try {
    await act(async () => root.render(<Shell attachments={[{ previewUrl: "blob:removed" }]} />));
    await act(async () =>
      root.render(<Shell attachments={[{ previewUrl: "blob:a" }, {}, { previewUrl: "blob:b" }]} />),
    );
    expect(revoke).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(revoke.mock.calls).toEqual([["blob:a"], ["blob:b"]]);
  } finally {
    vi.unstubAllGlobals();
  }
});
