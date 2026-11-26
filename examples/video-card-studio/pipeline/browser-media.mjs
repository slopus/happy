/** Read a response stream, not business state. Enforce the limit before writing each chunk. */
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function boundedFile(read, target, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('媒体已达大小上限');
  const temp = `${target}.${randomUUID()}.tmp`, file = await open(temp, 'wx', 0o600); let size = 0;
  try {
    for (;;) {
      const { done, value } = await read();
      if (value?.length) {
        size += value.length;
        if (size > limit) throw new Error('媒体超过大小上限');
        await file.writeFile(value);
      }
      if (done) break;
    }
    if (!size) throw new Error('媒体为空');
    await file.sync(); await file.close(); await rename(temp, target); return size;
  } finally { await file.close().catch(() => {}); await rm(temp, { force: true }); }
}

/** Ego Page.evaluate is the only browser transport; never export cookies or signed media URLs. */
export async function downloadBrowserMedia(page, url, target, limit, expectedUrl) {
  const key = '__pawsMedia_' + randomUUID().replaceAll('-', '');
  try {
    await page.evaluate(async ({ url, key, limit, expectedUrl }) => {
      if (location.href !== expectedUrl) throw new Error('作品地址已改变');
      const controller = new AbortController();
      const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
      if (!response.ok || Number(response.headers.get('content-length')) > limit) { controller.abort(); throw new Error('媒体读取失败或超过上限'); }
      window[key] = { reader: response.body.getReader(), controller, size: 0, limit };
    }, { url, key, limit, expectedUrl });
    return await boundedFile(async () => {
      const packet = await page.evaluate(async ({ key, expectedUrl }) => {
        if (location.href !== expectedUrl) throw new Error('作品地址已改变');
        const state = window[key]; if (!state) throw new Error('媒体流已丢失');
        const chunks = []; let count = 0, done = false;
        // Await incoming bytes, with no timer or repeated business-state query.
        while (count < 1024 * 1024 && !done) {
          const part = await state.reader.read(); done = part.done;
          if (part.value?.length) {
            state.size += part.value.length;
            if (state.size > state.limit) { state.controller.abort(); throw new Error('媒体超过大小上限'); }
            chunks.push(part.value); count += part.value.length;
          }
        }
        let binary = '';
        for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
        return { done, data: btoa(binary) };
      }, { key, expectedUrl });
      if (packet.data.length > 4 * 1024 * 1024) throw new Error('媒体分块超过上限');
      return { done: packet.done, value: Buffer.from(packet.data, 'base64') };
    }, target, limit);
  } finally {
    await page.evaluate(({ key, expectedUrl }) => {
      if (location.href !== expectedUrl) return;
      const state = window[key]; if (state) { state.controller.abort(); delete window[key]; }
    }, { key, expectedUrl }).catch(() => {});
  }
}
