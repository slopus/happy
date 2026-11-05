import sharp from 'sharp';

// Only the enclosed aperture connected to its centre belongs to the screen.
// Inverting alpha without this flood fill also includes the transparent exterior.
export async function screenMask(frame, aperture, output) {
  const { data: alpha, info } = await sharp(frame).ensureAlpha().extractChannel('alpha').raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const { x, y, width: w, height: h } = aperture;
  const seen = new Uint8Array(width * height), queue = new Int32Array(width * height);
  let read = 0, write = 1;
  queue[0] = (y + Math.floor(h / 2)) * width + x + Math.floor(w / 2);
  seen[queue[0]] = 1;
  while (read < write) {
    const p = queue[read++], px = p % width;
    for (const n of [px > 0 ? p - 1 : -1, px < width - 1 ? p + 1 : -1, p - width, p + width]) {
      if (n < 0 || n >= alpha.length || seen[n] || alpha[n] >= 250) continue;
      seen[n] = 1; queue[write++] = n;
    }
  }
  if (seen[0] || write < w * h * .5) throw Error('Screen aperture is not enclosed');
  const mask = Buffer.alloc(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const source = (y + j) * width + x + i;
    mask[j * w + i] = seen[source] ? 255 - alpha[source] : 0;
  }
  await sharp(mask, { raw: { width: w, height: h, channels: 1 } }).png().toFile(output);
}