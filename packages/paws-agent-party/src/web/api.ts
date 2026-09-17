export class Unauthorized extends Error {}
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export type Api = ReturnType<typeof createApi>;

export function bootstrapToken(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>, storage: Pick<Storage, 'getItem' | 'setItem'>): string {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (token !== null) {
    history.replaceState(null, '', location.pathname + location.search);
    storage.setItem('apToken', token);
  }
  return token ?? storage.getItem('apToken') ?? '';
}

export function validateImages(files: ArrayLike<Pick<File, 'type' | 'size'>>, existing: number): void {
  if (existing + files.length > 4) throw new Error('最多 4 张图片。');
  for (const file of Array.from(files)) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('仅支持 PNG、JPEG、WebP 图片。');
    if (file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error('每张图片须大于 0 且不超过 10 MiB。');
  }
}

export function createApi(token: () => string, unauthorized: () => void, transport: typeof fetch = fetch, baseUrl: string = import.meta.env.BASE_URL) {
  const prefix = (baseUrl ?? '/').replace(/\/$/, '');
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token()}`);
    if (typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await transport(`${prefix}${path}`, { ...init, headers, cache: 'no-store' });
    if (response.status === 401) { unauthorized(); throw new Unauthorized('访问令牌无效，请重新输入。'); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(response.status, typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : `请求失败 (${response.status})`);
    }
    return response;
  };
  const api = async <T,>(path: string, init?: RequestInit): Promise<T> => (await request(path, init)).json() as Promise<T>;
  api.blob = async (path: string, signal?: AbortSignal): Promise<Blob> => (await request(path, { signal })).blob();
  return api;
}
