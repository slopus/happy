import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** A bounded handshake followed by an event-driven stream with no body-idle timeout.
 * Node fetch applies an idle body deadline even after SSE headers arrive. A quiet
 * task is valid, so use the native HTTP stream; cancellation still closes it.
 * No redirects: a task credential must never follow a response to another host.
 */
export function openEventStream(url, { headers, signal, headerTimeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('invalid-event-origin');
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { headers, signal }, response => {
      clearTimeout(deadline);
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream')) {
        response.destroy(); reject(new Error('event-connection-failed')); return;
      }
      resolve({ ok: true, headers: new Headers({ 'content-type': response.headers['content-type'] }), body: response });
    });
    const deadline = setTimeout(() => request.destroy(new Error('event-connection-timeout')), headerTimeoutMs);
    request.once('error', error => { clearTimeout(deadline); reject(error); });
    request.end();
  });
}
