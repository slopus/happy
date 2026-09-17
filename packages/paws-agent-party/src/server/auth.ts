import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(header: string | undefined, accessToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(accessToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function validateRequestAuthority(input: {
  host: string | undefined;
  origin: string | undefined;
  port: number;
}): boolean {
  const authorities = new Set([`127.0.0.1:${input.port}`, `localhost:${input.port}`, `[::1]:${input.port}`]);
  if (!input.host || !authorities.has(input.host.toLowerCase())) return false;
  if (!input.origin) return true;
  try {
    const origin = new URL(input.origin);
    return origin.protocol === 'http:' && authorities.has(origin.host.toLowerCase()) && origin.username === '' && origin.password === '';
  } catch {
    return false;
  }
}
