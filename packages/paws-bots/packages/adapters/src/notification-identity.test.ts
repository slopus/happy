import { notificationAvatarSource } from "@rakazo/core";
import { expect, it, vi } from "vitest";
import { notificationIdentity } from "./notification-identity.js";

/** Installed iOS and Android apps drop an avatar over 1400 base64 characters. */
const MAX_AVATAR_BYTES = 1050;

it.each([
  { style: "organic", avatarSet: "organic", color: "#14b8a6" },
  { style: "logo", avatarSet: "rakazo", color: "#14b8a6" },
  { style: "shape", avatarSet: null, color: "#8B5CF6::shape_3" },
  { style: "dark shape", avatarSet: null, color: "#111827::shape_5" },
])(
  `sends the $style avatar at 96px and a 120px one for larger senders within the app's limit`,
  async ({ avatarSet, color }) => {
    const identity = await notificationIdentity({
      id: "agent-1",
      name: "Head of Marketing",
      color,
      avatarSet,
    });
    expect(identity.name).toBe("Head of Marketing");
    const { default: sharp } = await import("sharp");
    for (const [field, width] of [
      ["avatar", 96],
      ["avatarLarge", 120],
    ] as const) {
      const bytes = Buffer.from(identity[field]!, "base64");
      expect(bytes.length).toBeLessThanOrEqual(MAX_AVATAR_BYTES);
      expect(await sharp(bytes).metadata()).toMatchObject({ width, height: width, format: "png" });
    }
  },
);

it.each([
  { side: 96, sent: 64 },
  { side: 32, sent: 40 },
])(
  "shrinks a detailed $side px photo to $sent px instead of dropping it",
  async ({ side, sent }) => {
    const { default: sharp } = await import("sharp");
    let seed = side;
    const pixels = Buffer.from(
      Array.from({ length: side * side * 3 }, () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed >>> 24;
      }),
    );
    const photo = await sharp(pixels, { raw: { width: side, height: side, channels: 3 } })
      .png()
      .toBuffer();
    const identity = await notificationIdentity({
      id: `photo-${side}`,
      name: "Marketing",
      color: `data:image/png;base64,${photo.toString("base64")}`,
    });
    const bytes = Buffer.from(identity.avatar!, "base64");
    expect(bytes.length).toBeLessThanOrEqual(MAX_AVATAR_BYTES);
    expect(await sharp(bytes).metadata()).toMatchObject({
      width: sent,
      height: sent,
      format: "jpeg",
    });
    // The photo has no larger render: the next size up does not fit the payload budget either.
    expect(identity.avatarLarge).toBeUndefined();
  },
);

it("encodes every candidate at most once for a photo the larger sizes reject", async () => {
  const { default: sharp } = await import("sharp");
  let seed = 96;
  const pixels = Buffer.from(
    Array.from({ length: 96 * 96 * 3 }, () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed >>> 24;
    }),
  );
  const photo = await sharp(pixels, { raw: { width: 96, height: 96, channels: 3 } })
    .png()
    .toBuffer();
  const render = vi.spyOn(sharp.prototype, "toBuffer");
  const identity = await notificationIdentity({
    id: "photo-once",
    name: "Marketing",
    color: `data:image/png;base64,${photo.toString("base64")}`,
  });
  expect(identity.avatarLarge).toBeUndefined();
  // The 96px fit of the ordinary ladder is not tried again for the larger render.
  expect(render).toHaveBeenCalledTimes(3);
  render.mockRestore();
});

it("uses a saved profile picture, with no external avatar fetch", async () => {
  const { default: sharp } = await import("sharp");
  const original = await sharp({
    create: { width: 48, height: 48, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const color = `data:image/png;base64,${original.toString("base64")}`;
  expect(notificationAvatarSource({ id: "bot", color })).toBe(color);
  const identity = await notificationIdentity({ id: "bot", name: "Marketing", color });
  const pixel = await sharp(Buffer.from(identity.avatar!, "base64")).raw().toBuffer();
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[1]).toBeLessThan(20);
  expect(await sharp(Buffer.from(identity.avatarLarge!, "base64")).metadata()).toMatchObject({
    width: 120,
    height: 120,
    format: "jpeg",
  });
  expect(
    notificationAvatarSource({ id: "bot", color: "https://untrusted.example/avatar.png" }),
  ).toMatch(/^data:image\/svg\+xml,/);
});

it("shares one render per avatar and does not retry a broken one", async () => {
  const color = "data:image/png;base64,bm90IGFuIGltYWdl";
  const bot = { id: "broken", name: "Marketing", color };
  const { default: sharp } = await import("sharp");
  const render = vi.spyOn(sharp.prototype, "toBuffer");
  const [first, second] = await Promise.all([notificationIdentity(bot), notificationIdentity(bot)]);
  await notificationIdentity(bot);
  expect(first).toEqual({ botId: "broken", name: "Marketing" });
  expect(second).toEqual(first);
  expect(render).toHaveBeenCalledTimes(1);
  render.mockRestore();
});
