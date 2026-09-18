import { useEffect, useRef, useState } from 'react';
import type { BrowseDirectoryResult } from '@wangjs-jacky/paws-agent';
import type { Api } from './api.js';

export function RemoteDirectoryPicker({ machineId, value, onChange, api, disabled = false }: {
  machineId: string; value: string; onChange(path: string): void; api: Api; disabled?: boolean;
}) {
  const [listing, setListing] = useState<Extract<BrowseDirectoryResult, { success: true }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const browse = async (path?: string) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await api<BrowseDirectoryResult>(`/api/paws/machines/${encodeURIComponent(machineId)}/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.success) throw new Error(result.error);
      setListing(result);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return <fieldset className="remote-directory-picker" disabled={disabled || !machineId}>
    <legend>工作目录</legend>
    <p>{value || (machineId ? '尚未选择文件夹' : '请先选择远端机器')}</p>
    <button type="button" onClick={() => void browse(value || undefined)} disabled={loading}>{loading ? '读取目录…' : value ? '更换文件夹' : '选择文件夹'}</button>
    {error && <p role="alert">{error}</p>}
    {listing && <div className="directory-browser" aria-label="远端文件夹">
      <small>{listing.path}</small>
      {listing.parent && <button type="button" disabled={loading} onClick={() => void browse(listing.parent!)}>↑ 上一级</button>}
      {listing.directories.map(item => <button type="button" key={item.path} disabled={loading} onClick={() => void browse(item.path)}>📁 {item.name}</button>)}
      {!listing.directories.length && <p>此目录下没有子文件夹</p>}
      <button type="button" disabled={loading || !!error} onClick={() => { onChange(listing.path); setListing(null); }}>选择当前目录</button>
    </div>}
  </fieldset>;
}
