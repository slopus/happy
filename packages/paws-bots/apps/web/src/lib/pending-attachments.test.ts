import { describe, expect, it, vi } from "vitest";
import { isFileDrag, isFilePaste, revokePendingAttachmentPreviews } from "./pending-attachments.js";

function fileList(length: number) {
  return { length } as unknown as FileList;
}

function pasteData(files: number, itemKinds: string[] = []) {
  return {
    files: fileList(files),
    items: itemKinds.map((kind) => ({ kind })),
  } as unknown as DataTransfer;
}

function dragData(types: string[], itemKinds: string[] = []) {
  return {
    types,
    items: itemKinds.map((kind) => ({ kind })),
  } as unknown as DataTransfer;
}

describe("isFileDrag", () => {
  it("recognizes files advertised by the drag data", () => {
    expect(isFileDrag(dragData(["Files"]))).toBe(true);
  });

  it("recognizes file items when the Files type is not exposed", () => {
    expect(isFileDrag(dragData([], ["file"]))).toBe(true);
  });

  it("ignores text and other drags", () => {
    expect(isFileDrag(dragData(["text/plain"], ["string"]))).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});

describe("isFilePaste", () => {
  it("recognizes pasted files", () => {
    expect(isFilePaste(pasteData(1))).toBe(true);
  });

  it("ignores file-kind items when the file list is empty", () => {
    expect(isFilePaste(pasteData(0, ["file"]))).toBe(false);
  });

  it("ignores text-only pastes", () => {
    expect(isFilePaste(pasteData(0, ["string"]))).toBe(false);
    expect(isFilePaste(null)).toBe(false);
    expect(isFilePaste(undefined)).toBe(false);
  });
});

describe("revokePendingAttachmentPreviews", () => {
  it("revokes each preview URL and skips entries without one", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    revokePendingAttachmentPreviews([{ previewUrl: "blob:a" }, {}, { previewUrl: "blob:b" }]);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(revoke).toHaveBeenCalledWith("blob:b");
    revoke.mockRestore();
  });
});
