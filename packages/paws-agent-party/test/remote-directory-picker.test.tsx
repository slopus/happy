// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RemoteDirectoryPicker } from '../src/web/RemoteDirectoryPicker.js';
afterEach(cleanup);

it('browses children and parents and selects the server-returned canonical path', async () => {
  const onChange = vi.fn();
  const api = vi.fn(async (path: string) => path.includes('?')
    ? { success: true, path: '/home/jacky/project', parent: '/home/jacky', directories: [] }
    : { success: true, path: '/home/jacky', parent: '/home', directories: [{ name: 'project', path: '/home/jacky/project' }] });
  render(<RemoteDirectoryPicker machineId="mac" value="" onChange={onChange} api={api as never}/>);
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  fireEvent.click(await screen.findByRole('button', { name: '📁 project' }));
  await screen.findByText('/home/jacky/project');
  expect(api.mock.calls[1][0]).toBe('/api/paws/machines/mac/directories?path=%2Fhome%2Fjacky%2Fproject');
  expect(screen.getByRole('button', { name: '↑ 上一级' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '选择当前目录' }));
  expect(onChange).toHaveBeenCalledWith('/home/jacky/project');
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('does not display an old machine response after switching machines', async () => {
  let finish!: (value: unknown) => void;
  const api = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const props = { value: '', onChange: vi.fn(), api: api as never };
  const { rerender } = render(<RemoteDirectoryPicker key="a" machineId="a" {...props}/>);
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  rerender(<RemoteDirectoryPicker key="b" machineId="b" {...props}/>);
  finish({ success: true, path: '/old-machine', parent: '/', directories: [] });
  await vi.waitFor(() => expect(screen.queryByText('/old-machine')).toBeNull());
  expect(screen.queryByRole('button', { name: '选择当前目录' })).toBeNull();
});

it('reports remote failures and allows retry', async () => {
  const api = vi.fn().mockResolvedValueOnce({ success: false, error: '机器已离线' }).mockResolvedValueOnce({ success: true, path: '/home', directories: [] });
  render(<RemoteDirectoryPicker machineId="mac" value="" onChange={vi.fn()} api={api as never}/>);
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '机器已离线');
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  await screen.findByRole('button', { name: '选择当前目录' });
  expect(screen.queryByRole('alert')).toBeNull();
});
