export * from "@rakazo/core/plot";

/** Rasterize a rendered plot SVG to an opaque PNG. The SVG's CSS background is
    not honored by all rasterizers, and a transparent chart is unreadable on
    dark chat themes, so the alpha channel is flattened onto white. */
export async function plotSvgToPng(svg: string): Promise<Buffer> {
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(svg), { density: 144 })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}
