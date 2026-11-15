import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canPrepareImage, prepareImage } from "./prepare-image.js";

const close = vi.fn();
const drawImage = vi.fn();
const toBlob = vi.fn();
const bitmap = vi.fn();
let canvas: {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: typeof toBlob;
};

beforeEach(() => {
  vi.clearAllMocks();
  bitmap.mockResolvedValue({ width: 3200, height: 2400, close });
  toBlob.mockImplementation((callback, type) => callback(new Blob(["compressed"], { type })));
  canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })), toBlob };
  vi.stubGlobal("createImageBitmap", bitmap);
  vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
});
afterEach(() => vi.unstubAllGlobals());

function photo(type = "image/jpeg", size = 100) {
  return new File([type === "image/png" ? png(false) : new Uint8Array(size)], "photo", {
    type,
    lastModified: 123,
  });
}

describe("prepareImage", () => {
  it.each([
    [1600, 1200],
    [800, 1600],
    [1, 1],
  ])("preserves small images at %i × %i byte-for-byte", async (width, height) => {
    bitmap.mockResolvedValue({ width, height, close });
    const file = photo();
    expect(await prepareImage(file)).toBe(file);
    expect(toBlob).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    [3200, 2400, 1600, 1200],
    [1000, 4000, 400, 1600],
  ])("fits %i × %i within the longest edge", async (width, height, targetWidth, targetHeight) => {
    bitmap.mockResolvedValue({ width, height, close });
    const result = await prepareImage(photo());
    expect([canvas.width, canvas.height]).toEqual([targetWidth, targetHeight]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, targetWidth, targetHeight);
    expect(result.name).toBe("photo");
    expect(result.lastModified).toBe(123);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["image/jpeg", "image/png"])("retains %s encoding", async (type) => {
    const result = await prepareImage(photo(type));
    expect(result.type).toBe(type);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), type, 0.7);
  });

  it("preserves images just below the byte threshold", async () => {
    bitmap.mockResolvedValue({ width: 1600, height: 1200, close });
    const file = photo("image/jpeg", 5 * 1024 * 1024 - 1);
    expect(await prepareImage(file)).toBe(file);
    expect(toBlob).not.toHaveBeenCalled();
  });

  it("infers image types from filenames when the picker omits the MIME type", async () => {
    const file = new File(["image"], "photo.jpg");
    expect(canPrepareImage(file)).toBe(true);
    expect((await prepareImage(file)).type).toBe("image/jpeg");
  });

  it("falls back when the browser cannot decode images", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const file = photo();
    expect(await prepareImage(file)).toBe(file);
  });

  it("recompresses byte-heavy images without upscaling", async () => {
    bitmap.mockResolvedValue({ width: 1200, height: 800, close });
    const file = photo("image/jpeg", 5 * 1024 * 1024);
    expect(await prepareImage(file)).not.toBe(file);
    expect([canvas.width, canvas.height]).toEqual([1200, 800]);
  });

  it.each(["image/gif", "image/webp", "image/svg+xml", "application/pdf"])(
    "leaves %s alone",
    async (type) => {
      const file = photo(type);
      expect(await prepareImage(file)).toBe(file);
      expect(bitmap).not.toHaveBeenCalled();
    },
  );

  it("preserves byte-heavy WebP without decoding away animation", async () => {
    const file = photo("image/webp", 5 * 1024 * 1024);
    expect(canPrepareImage(file)).toBe(false);
    expect(await prepareImage(file)).toBe(file);
    expect(bitmap).not.toHaveBeenCalled();
  });

  it.each(["decode", "context", "draw", "encode", "empty", "wrong format"])(
    "falls back on %s failure",
    async (failure) => {
      if (failure === "decode") bitmap.mockRejectedValue(new Error("decode failed"));
      if (failure === "context") canvas.getContext.mockReturnValue(null);
      if (failure === "draw")
        drawImage.mockImplementationOnce(() => {
          throw new Error("draw failed");
        });
      if (failure === "encode")
        toBlob.mockImplementationOnce(() => {
          throw new Error("encode failed");
        });
      if (failure === "empty") toBlob.mockImplementationOnce((callback) => callback(null));
      if (failure === "wrong format")
        toBlob.mockImplementationOnce((callback) =>
          callback(new Blob(["png"], { type: "image/png" })),
        );
      const file = photo();
      expect(await prepareImage(file)).toBe(file);
      if (failure !== "decode") expect(close).toHaveBeenCalledOnce();
    },
  );
});

function png(animated: boolean) {
  const bytes = new Uint8Array(animated ? 61 : 41);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  if (animated) bytes.set([0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 2], 33);
  bytes.set([0, 0, 0, 0, 73, 68, 65, 84], animated ? 53 : 33);
  return bytes;
}

it.each([1700, 1000])("preserves APNG before decoding at %i pixels", async (width) => {
  bitmap.mockResolvedValue({ width, height: 1000, close });
  const file = new File([png(true)], "animated.png", { type: "image/png" });
  expect(await prepareImage(file)).toBe(file);
  expect(bitmap).not.toHaveBeenCalled();
  expect(toBlob).not.toHaveBeenCalled();
});
it("retains PNG when header inspection fails", async () => {
  const file = photo("image/png");
  vi.spyOn(file, "slice").mockImplementation(() => {
    throw new Error("read failed");
  });
  expect(await prepareImage(file)).toBe(file);
  expect(bitmap).not.toHaveBeenCalled();
});
it("retains an inconclusive or malformed PNG header", async () => {
  const file = new File([new Uint8Array(100)], "unknown.png", { type: "image/png" });
  expect(await prepareImage(file)).toBe(file);
  expect(bitmap).not.toHaveBeenCalled();
});
