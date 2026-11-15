import { describe, expect, it } from "vitest";
import {
  attachedImageArtifactIds,
  encodeBotAvatarImage,
  resolveUpdateBotAvatar,
} from "./bot-avatar.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

describe("bot avatar encoding", () => {
  it("encodes an attached image as a square webp data URL", async () => {
    const dataUrl = await encodeBotAvatarImage(PNG_1X1);
    expect(dataUrl.startsWith("data:image/webp;base64,")).toBe(true);
    expect(dataUrl.length).toBeGreaterThan("data:image/webp;base64,".length);
  });

  it("lists attached image artifact ids in order", () => {
    expect(
      attachedImageArtifactIds([
        { kind: "text", text: "hi" },
        { kind: "image", artifactId: "img-1", mimeType: "image/png", name: "a.png" },
        { kind: "image", artifactId: "img-2", mimeType: "image/jpeg", name: "b.jpg" },
      ]),
    ).toEqual(["img-1", "img-2"]);
  });

  it("resolves hex color writes", async () => {
    await expect(
      resolveUpdateBotAvatar({
        color: "#8B5CF6::shape_2",
        sourceImageArtifactIds: [],
        loadArtifact: async () => null,
      }),
    ).resolves.toEqual({ color: "#8B5CF6::shape_2" });
  });

  it("rejects remote URLs and missing attached images", async () => {
    await expect(
      resolveUpdateBotAvatar({
        color: "https://evil.example/x.png",
        sourceImageArtifactIds: [],
        loadArtifact: async () => null,
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("hex") });
    await expect(
      resolveUpdateBotAvatar({
        useAttachedImage: true,
        sourceImageArtifactIds: [],
        loadArtifact: async () => null,
      }),
    ).resolves.toEqual({ error: "No attached image on this message." });
  });

  it("loads only the requested space image", async () => {
    const loadArtifact = async (id: string) => (id === "img-2" ? new Uint8Array(PNG_1X1) : null);
    const fromId = await resolveUpdateBotAvatar({
      artifactId: "img-2",
      sourceImageArtifactIds: ["img-1", "img-2"],
      loadArtifact,
    });
    expect("color" in fromId && fromId.color.startsWith("data:image/webp;base64,")).toBe(true);

    const fromLatest = await resolveUpdateBotAvatar({
      useAttachedImage: true,
      sourceImageArtifactIds: ["img-1", "img-2"],
      loadArtifact,
    });
    expect("color" in fromLatest && fromLatest.color.startsWith("data:image/webp;base64,")).toBe(
      true,
    );

    await expect(
      resolveUpdateBotAvatar({
        artifactId: "other-space",
        sourceImageArtifactIds: ["img-2"],
        loadArtifact,
      }),
    ).resolves.toEqual({
      error: "Image is not in this space or is not an attached picture.",
    });
  });
});
