import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ContextBudgetError, estimateContextTokens, selectContext } from "./context-selection.js";
import { estimatePiImageTokens } from "./pi-image-context.js";

describe("Pi image context planning", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpeg"],
    ["image/webp", "webp"],
  ] as const)("uses dimensions from valid %s image headers", async (mimeType, format) => {
    const pipeline = sharp({
      create: { width: 640, height: 480, channels: 3, background: "white" },
    });
    const image = await pipeline[format]().toBuffer();
    expect(estimatePiImageTokens({ type: "image", data: image.toString("base64"), mimeType })).toBe(
      1024,
    );
  });

  it.each([
    [1, 1, 1024],
    [32, 32, 1024],
    [512, 512, 1024],
    [1024, 1024, 1399],
    [2048, 2048, 5593],
    [2048, 513, 1445],
    [513, 2048, 1445],
    [4000, 3000, 4195],
    [3000, 4000, 4195],
    [8000, 6000, 4195],
    [8000, 1000, 1024],
  ])("bounds a %ix%i JPEG at %i tokens", async (width, height, expected) => {
    const image = await sharp({
      create: { width, height, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const part = { type: "image", data: image.toString("base64"), mimeType: "image/jpeg" };
    expect(estimatePiImageTokens(part)).toBe(expected);
    const selected = selectContext([{ role: "user", content: [part] }], {
      budget: {
        contextWindow: 16_384,
        outputReserve: 4096,
        systemPrompt: "Describe the image",
        tools: [],
        imageTokens: estimatePiImageTokens,
      },
      strategy: "retrieval",
    });
    expect(selected.messages[0]!.content).toEqual([part]);
    expect(selected.estimatedInputTokens).toBeLessThan(16_384 - 4096);
  });

  it("counts GIF frames over the full logical-screen canvas", async () => {
    const gif = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "white" },
    })
      .gif()
      .toBuffer();
    expect(
      estimatePiImageTokens({ type: "image", data: gif.toString("base64"), mimeType: "image/gif" }),
    ).toBe(1024);
    const globalPaletteEnd = 13 + 3 * 2 ** ((gif[10]! & 7) + 1);
    const frame = gif.subarray(globalPaletteEnd, -1);
    const animated = Buffer.concat([gif.subarray(0, -1), frame, gif.subarray(-1)]);
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: animated.toString("base64"),
        mimeType: "image/gif",
      }),
    ).toBe(2048);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: animated.subarray(0, -1).toString("base64"),
        mimeType: "image/gif",
      }),
    ).toBeUndefined();
    const smallFrame = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .gif()
      .toBuffer();
    smallFrame.writeUInt16LE(640, 6);
    smallFrame.writeUInt16LE(480, 8);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: smallFrame.toString("base64"),
        mimeType: "image/gif",
      }),
    ).toBe(1024);
  });

  it("keeps malformed GIF headers and incomplete frame blocks byte-counted", async () => {
    const gif = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "white" },
    })
      .gif()
      .toBuffer();
    const globalPaletteEnd = 13 + 3 * 2 ** ((gif[10]! & 7) + 1);
    const descriptor = gif.indexOf(0x2c, globalPaletteEnd);
    expect(descriptor).toBeGreaterThan(globalPaletteEnd);
    const estimate = (bytes: Buffer) =>
      estimatePiImageTokens({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/gif",
      });

    const zeroCanvas = Buffer.from(gif);
    zeroCanvas.writeUInt16LE(0, 6);
    expect(estimate(zeroCanvas)).toBeUndefined();

    const invalidCodeSize = Buffer.from(gif);
    invalidCodeSize[descriptor + 10] = 9;
    expect(estimate(invalidCodeSize)).toBeUndefined();

    const incompleteLocalPalette = Buffer.from(gif.subarray(0, descriptor + 10));
    incompleteLocalPalette[descriptor + 9] = 0x80;
    expect(estimate(incompleteLocalPalette)).toBeUndefined();

    const truncatedSubBlock = Buffer.from(gif.subarray(0, descriptor + 12));
    truncatedSubBlock[descriptor + 11] = 255;
    expect(estimate(truncatedSubBlock)).toBeUndefined();
  });

  it("counts declared APNG frames and static PNG dimensions", async () => {
    const png = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const acTL = Buffer.alloc(20);
    acTL.writeUInt32BE(8, 0);
    acTL.write("acTL", 4, "ascii");
    acTL.writeUInt32BE(2, 8);
    const animated = Buffer.concat([png.subarray(0, 33), acTL, png.subarray(33)]);
    expect(
      estimatePiImageTokens({ type: "image", data: png.toString("base64"), mimeType: "image/png" }),
    ).toBe(1024);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: animated.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBe(3072);
    const fcTL = Buffer.alloc(38);
    fcTL.writeUInt32BE(26, 0);
    fcTL.write("fcTL", 4, "ascii");
    const firstFrameAnimated = Buffer.concat([png.subarray(0, 33), acTL, fcTL, png.subarray(33)]);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: firstFrameAnimated.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBe(2048);
    const malformed = Buffer.from(animated);
    malformed.writeUInt32BE(0, 41);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: malformed.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBeUndefined();
  });

  it("counts animated WebP frames from complete RIFF chunks", async () => {
    const pixels = Buffer.alloc(640 * 480 * 2);
    pixels.fill(255, 0, 640 * 480);
    const gif = await sharp(pixels, {
      raw: { width: 640, height: 960, channels: 1, pageHeight: 480 },
    })
      .gif({ loop: 0 })
      .toBuffer();
    const webp = await sharp(gif, { animated: true }).webp({ loop: 0 }).toBuffer();
    expect((await sharp(webp, { animated: true }).metadata()).pages).toBe(2);
    const estimate = (bytes: Buffer) =>
      estimatePiImageTokens({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/webp",
      });
    expect(estimate(webp)).toBe(2048);
    expect(estimate(webp.subarray(0, -1))).toBeUndefined();
    const frameOffset = webp.indexOf(Buffer.from("ANMF"));
    expect(frameOffset).toBeGreaterThan(0);
    const emptyFrame = Buffer.from(webp.subarray(0, frameOffset + 8 + 16));
    emptyFrame.writeUInt32LE(16, frameOffset + 4);
    emptyFrame.writeUInt32LE(emptyFrame.length - 8, 4);
    expect(estimate(emptyFrame)).toBeUndefined();
  });

  it("keeps malformed images byte-counted and never substitutes image-shaped tool arguments", () => {
    const malformed = { type: "image", data: "a".repeat(300_000), mimeType: "image/png" };
    expect(estimatePiImageTokens(malformed)).toBeUndefined();
    expect(
      estimateContextTokens([{ role: "user", content: [malformed] }], estimatePiImageTokens),
    ).toBeGreaterThan(300_000);
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "upload", arguments: malformed }],
    };
    // Tool arguments are text the model reads, never an image estimate.
    expect(estimateContextTokens(call, estimatePiImageTokens)).toBe(estimateContextTokens(call));
    expect(estimateContextTokens(call, estimatePiImageTokens)).toBeGreaterThan(90_000);
  });

  it("makes implausibly large declared dimensions exceed any configured context window", async () => {
    const image = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    image.writeUInt32BE(0xffffffff, 16);
    image.writeUInt32BE(0xffffffff, 20);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: image.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("budgets a valid screenshot from dimensions while preserving its actual tool result", async () => {
    const pixels = Buffer.alloc(1024 * 1024);
    let seed = 1;
    for (let index = 0; index < pixels.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[index] = seed & 255;
    }
    const image = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 1 } })
      .png()
      .toBuffer();
    const part = { type: "image", data: image.toString("base64"), mimeType: "image/png" };
    const messages = [
      { role: "user", content: "Inspect the screen" },
      { role: "assistant", content: [{ type: "toolCall", id: "shot", name: "observe" }] },
      { role: "toolResult", toolCallId: "shot", content: [part] },
    ];
    const budget = { contextWindow: 128_000, outputReserve: 4096, systemPrompt: "", tools: [] };
    expect(() => selectContext(messages, { budget, strategy: "retrieval" })).toThrow(
      ContextBudgetError,
    );
    const selected = selectContext(messages, {
      budget: { ...budget, imageTokens: estimatePiImageTokens },
      strategy: "retrieval",
    });
    expect(estimatePiImageTokens(part)).toBe(1399);
    expect(selected.messages.at(-1)!.content).toEqual([part]);
    expect(selected.estimatedInputTokens).toBeLessThan(128_000 - 4096);
  });
});
