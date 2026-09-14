import { afterEach, describe, expect, it, vi } from "vitest";
const { decrypt } = vi.hoisted(() => ({ decrypt: vi.fn(() => new Uint8Array([97])) }));
vi.mock("@/encryption/blob", () => ({ decryptBlob: decrypt }));
vi.mock("./apiSocket", () => ({ getHappyClientId: () => "test" }));
vi.mock("./serverConfig", () => ({
  getServerUrl: () => "https://happy.test",
  rewriteLoopbackHost: (url: string) => url,
}));
import { loadSessionAvatar } from "./sessionAvatars";
import type { Encryption } from "./encryption/encryption";

const descriptor = { ref: "sessions/s/avatar/a.enc", version: 1, preview: "opaque-preview" };
const encryption = {
  getSessionEncryption: () => ({
    decryptRaw: async () => ({ thumbhash: "hash", mimeType: "image/webp" }),
  }),
  getSessionBlobKey: () => new Uint8Array(32),
} as unknown as Encryption;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("encrypted session avatar download", () => {
  it.each(["https://happy.test/image", "https://files.test/image"])(
    "decrypts artwork and scopes bearer credentials for %s",
    async (downloadUrl) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ref: descriptor.ref, downloadUrl }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2])));
      vi.stubGlobal("fetch", fetch);
      const result = await loadSessionAvatar(
        { token: "private-token", secret: "secret" },
        encryption,
        "s",
        descriptor,
        new AbortController().signal,
      );
      expect(result?.uri).toBe("data:image/webp;base64,YQ==");
      expect(fetch.mock.calls[0][0]).toBe(
        "https://happy.test/v1/sessions/s/avatar/request-download",
      );
      expect(fetch.mock.calls[1][1].headers?.Authorization).toBe(
        downloadUrl.startsWith("https://happy.test/") ? "Bearer private-token" : undefined,
      );
      expect(fetch.mock.calls[1][1].redirect).toBe("error");
    },
  );

  it("does not pair a stale preview with replacement bytes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ref: "new-ref", downloadUrl: "https://files.test/image" }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(
      await loadSessionAvatar(
        { token: "token", secret: "secret" },
        encryption,
        "s",
        descriptor,
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
