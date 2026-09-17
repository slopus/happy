import { expect, it, vi } from 'vitest';
import { bootstrapToken, validateImages, createApi } from '../src/web/api.js';

it('keeps JSON and image requests within the deployed application prefix', async () => {
  const paths: string[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    paths.push(String(input));
    return Response.json({ ok: true });
  });
  const api = createApi(() => 'test', () => {}, transport, '/agent-party/');
  await api('/api/paws/status');
  await api.blob('/api/assets/image-id');
  expect(paths).toEqual(['/agent-party/api/paws/status', '/agent-party/api/assets/image-id']);
});

it('removes the access token fragment and stores it only for this tab', () => {
  const saved = new Map<string, string>();
  let replacement = '';
  const token = bootstrapToken({ hash: '#token=private-test', pathname: '/', search: '?x=1' }, { replaceState: (_a, _b, url) => { replacement = String(url); } }, { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } });
  expect(token).toBe('private-test');
  expect(replacement).toBe('/?x=1');
  expect(saved.get('apToken')).toBe(token);
});

it('validates image-only batches before uploading and rejects mixed invalid files', () => {
  expect(() => validateImages([{ type: 'image/png', size: 123 }], 0)).not.toThrow();
  expect(() => validateImages([{ type: 'text/plain', size: 1 }], 0)).toThrow();
  expect(() => validateImages([{ type: 'image/png', size: 11 * 1024 * 1024 }], 0)).toThrow();
  expect(() => validateImages([{ type: 'image/png', size: 1 }], 4)).toThrow();
});

it('authorizes image fetches in headers without query tokens', async () => {
  let url = ''; let authorization = '';
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input); authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(new Blob(['image']), { headers: { 'content-type': 'image/png' } });
  });
  const api = createApi(() => 'private-test', () => {}, transport);
  expect((await api.blob('/api/assets/a')).size).toBe(5);
  expect(url).toBe('/api/assets/a');
  expect(authorization).toBe('Bearer private-test');
});
