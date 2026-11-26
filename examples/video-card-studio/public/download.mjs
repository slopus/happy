// Read a complete, bounded file before handing a local Blob to the browser.
// A successful HTTP header is not a successful download; partial bodies fail.
export const MAX_ARCHIVE_BYTES = 65 * 1024 * 1024;
const MAX_PNG_BYTES = 6 * 1024 * 1024;
const ZIP_SIGNATURE = [80, 75, 3, 4];
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function readArchiveBlob(url, { signal, fetchImpl = fetch, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  return readDownloadBlob(url, { signal, fetchImpl, maxBytes, type: 'application/zip', signature: ZIP_SIGNATURE });
}

export function readPngBlob(url, { signal, fetchImpl = fetch } = {}) {
  return readDownloadBlob(url, { signal, fetchImpl, maxBytes: MAX_PNG_BYTES, type: 'image/png', signature: PNG_SIGNATURE });
}

async function readDownloadBlob(url, { signal, fetchImpl, maxBytes, type, signature }) {
  const response = await fetchImpl(url, { signal, cache: 'no-store' });
  const declared = response.headers.get('content-length');
  const length = declared === null ? null : Number(declared);
  if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== type ||
      (length !== null && (!Number.isSafeInteger(length) || length < signature.length || length > maxBytes))) {
    await response.body?.cancel().catch(() => {});
    throw new Error('无法读取文件，请稍后重试。');
  }
  if (!response.body) throw new Error('下载内容为空，请重试。');
  const reader = response.body.getReader(), parts = [];
  let bytes = 0, finished = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { finished = true; break; }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('文件超过下载大小限制。');
      if (length !== null && bytes > length) throw new Error('下载内容长度不正确，请重试。');
      parts.push(next.value);
    }
    if (bytes < signature.length || (length !== null && bytes !== length)) throw new Error('下载内容不完整，请重试。');
    const blob = new Blob(parts, { type });
    const header = new Uint8Array(await blob.slice(0, signature.length).arrayBuffer());
    if (!header.every((byte, index) => byte === signature[index])) throw new Error('文件格式不正确，请重试。');
    return blob;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
