import { describe, expect, it } from "vitest";
import { attachmentPickerAccept } from "./attachment-picker-accept.js";

describe("attachmentPickerAccept", () => {
  it("lets Android document providers offer CSV files", () => {
    expect(attachmentPickerAccept("Mozilla/5.0 (Linux; Android 17; Pixel 7 Pro) Mobile")).toBe(
      "*/*",
    );
  });

  it("retains supported MIME types and file extensions on desktop", () => {
    const accept = attachmentPickerAccept("Mozilla/5.0 (X11; Linux x86_64) Chrome/140");
    expect(accept).toContain("text/csv");
    expect(accept).toContain(".csv");
    expect(accept).toContain("application/pdf");
    expect(accept).toContain(".zip");
    expect(accept).toContain("application/vnd.ms-excel");
    expect(accept).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(accept).toContain(".xls");
    expect(accept).toContain(".xlsx");
    expect(accept).not.toBe("*/*");
  });
});
