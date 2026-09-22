import { expect, it } from 'vitest';
import { AccountAccess } from '../src/server/account-access.js';
const transport = async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith('/v1/auth')) return Response.json({ token: 'B' });
  const token = new Headers(init?.headers).get('authorization')?.slice(7);
  return token === 'A' || token === 'B' ? Response.json({ id: token }) : new Response('', { status: 401 });
};
it('binds SDK credentials to the verified account rather than trusting the supplied secret', async () => {
  const access = new AccountAccess('http://relay.test', 'master', transport as typeof fetch);
  await expect(access.credentials({ id: 'A', name: '' }, Buffer.alloc(32, 1).toString('base64'))).rejects.toMatchObject({ status: 403 });
  await expect(access.credentials({ id: 'B', name: '' }, Buffer.alloc(32, 1).toString('base64url'))).resolves.toMatchObject({ token: 'B' });
});
it('separates account namespaces and rejects ticket replay, expiration and revoked sessions', async () => {
  let now = 1000;
  const access = new AccountAccess('http://relay.test', 'master', transport as typeof fetch, () => now);
  expect(access.tenantKey('A')).not.toBe(access.tenantKey('B'));
  expect(access.tenantToken('A')).not.toBe(access.tenantToken('B'));
  const ticket = access.issue({ id: 'A', name: '' }, 'A');
  const session = access.exchange(ticket);
  expect(() => access.exchange(ticket)).toThrow();
  expect((await access.authenticate(session.token)).account.id).toBe('A');
  access.logout(session.token);
  await expect(access.authenticate(session.token)).rejects.toMatchObject({ status: 401 });
  const expired = access.issue({ id: 'B', name: '' }, 'B'); now += 30001;
  expect(() => access.exchange(expired)).toThrow();
});

it('does not revive a session logged out while relay verification is pending', async () => {
  let now = 0;
  let resolve!: (response: Response) => void;
  const delayed = () => new Promise<Response>(done => { resolve = done; });
  const access = new AccountAccess('http://relay.test', 'master', delayed as typeof fetch, () => now);
  const { token } = access.exchange(access.issue({ id: 'A', name: '' }, 'A'));
  now = 60001;
  const pending = access.authenticate(token);
  access.logout(token);
  resolve(Response.json({ id: 'A' }));
  await expect(pending).rejects.toMatchObject({ status: 401 });
});
