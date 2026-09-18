// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AssetImage } from '../src/web/Attachments.js';
import { createApi } from '../src/web/api.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('opens the authenticated image with contained keyboard focus and restores focus on close', async () => {
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:private-image', revokeObjectURL: revoke });
  const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Blob(['image'], { type: 'image/png' })));
  const api = createApi(() => 'private-session', () => {}, transport);
  const view = render(<><button>Outside</button><AssetImage image={{ id: 'private', name: 'picture.png', mimeType: 'image/png', size: 5 }} api={api}/></>);
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: '打开图片 picture.png' });
  await user.click(trigger);
  expect(screen.getByRole('dialog', { name: 'picture.png' })).toBeTruthy();
  const close = screen.getByRole('button', { name: '关闭图片' });
  expect(document.activeElement).toBe(close);
  await user.tab(); expect(document.activeElement).toBe(close);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
  expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer private-session');
  view.unmount(); expect(revoke).toHaveBeenCalledWith('blob:private-image');
});
