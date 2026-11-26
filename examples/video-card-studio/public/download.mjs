// Read a complete, bounded archive before handing a local Blob to the browser.
// A successful HTTP header is not a successful download; partial bodies fail.
export const MAX_ARCHIVE_BYTES = 65 * 1024 * 1024;
export async function readArchiveBlob(url, { signal, fetchImpl = fetch, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  const response = await fetchImpl(url, { signal, cache: 'no-store' });
  const declared = response.headers.get('content-length');
  const length = declared === null ? null : Number(declared);
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/zip' ||
      (length !== null && (!Number.isSafeInteger(length) || length < 1 || length > maxBytes))) {
    await response.body?.cancel(); throw new Error('无法读取完整压缩包，请稍后重试。');
  }
  if (!response.body) throw new Error('下载内容为空，请重试。');
  const reader = response.body.getReader(), parts = [];
  let bytes = 0, finished = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { finished = true; break; }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('压缩包超过下载大小限制。');
      parts.push(next.value);
    }
    if (!bytes || (length !== null && bytes !== length)) throw new Error('下载内容不完整，请重试。');
    const blob = new Blob(parts, { type: 'application/zip' });
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (signature.length !== 4 || !signature.every((byte, index) => byte === [80, 75, 3, 4][index])) throw new Error('压缩包格式不正确，请重试。');
    return blob;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
