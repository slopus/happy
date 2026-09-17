import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { ConnectionStatus } from '../contracts.js';
import type { Api } from './api.js';
import { Button } from '../../vendor/agents-party/src/ui/components/button.js';
import { Input } from '../../vendor/agents-party/src/ui/components/input.js';

const labels = { disconnected: '未连接', linking: '等待扫码授权', connecting: '连接中', ready: '已连接', error: '连接失败' };
export function ConnectionPanel({ status, api, active, onChange }: { status: ConnectionStatus; api: Api; active: boolean; onChange: (status: ConnectionStatus) => void }) {
  const [serverUrl, setServerUrl] = useState(status.serverUrl ?? 'http://47.115.228.20:3005');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [qr, setQr] = useState('');
  const [linking, setLinking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const operation = useRef(0);
  useEffect(() => () => { operation.current += 1; }, []);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true; setQr('');
    if (status.qrUrl) void QRCode.toDataURL(status.qrUrl).then(value => { if (current) setQr(value); }).catch(() => { if (current) setError('二维码生成失败，请重试连接。'); });
    return () => { current = false; };
  }, [status.qrUrl]);
  const perform = async (mode: 'link' | 'recover' | 'disconnect') => {
    const current = ++operation.current;
    const disconnect = mode === 'disconnect';
    setLinking(!disconnect); setCancelling(disconnect); setError('');
    try {
      const endpoint = mode === 'recover' ? '/api/paws/recover' : '/api/paws/link';
      const init = disconnect ? { method: 'DELETE' as const } : { method: 'POST' as const, body: JSON.stringify(mode === 'recover' ? { serverUrl, recoveryCode } : { serverUrl }) };
      const next = await api<ConnectionStatus>(endpoint, init);
      if (current === operation.current) { if (mode === 'recover' && next.state === 'ready') setRecoveryCode(''); onChange(next); }
    } catch (error) { if (current === operation.current) setError((error as Error).message); }
    finally { if (current === operation.current) { setLinking(false); setCancelling(false); } }
  };
  return <details className="border-b border-border px-4 py-2" open={status.state !== 'ready'}>
    <summary className="font-accent text-sm">Paws：{labels[status.state]}{status.serverUrl ? ` · ${status.serverUrl}` : ''}</summary>
    <div className="flex flex-wrap items-end gap-3 py-2">
      <label className="min-w-64 flex-1 text-sm">SDK 服务地址<Input value={serverUrl} onChange={event => setServerUrl(event.target.value)} disabled={linking || cancelling || active} /></label>
      <Button disabled={linking || cancelling || active || !serverUrl.trim()} onClick={() => void perform('link')}>二维码授权</Button>
      <Button variant="secondary" disabled={cancelling || active || (!linking && status.state === 'disconnected')} onClick={() => void perform('disconnect')}>断开连接</Button>
      {qr && <img src={qr} alt="使用 Paws 扫码授权" className="size-44" />}
      <div className="w-full max-w-xl rounded-lg border border-border bg-muted/40 p-3"><p className="text-sm font-medium">二维码无法扫码？使用恢复码</p><div className="mt-2 flex flex-wrap gap-2"><Input aria-label="Paws 恢复码" type="password" autoComplete="off" value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} disabled={linking || cancelling || active} placeholder="输入 11 组恢复码，例如 XXXXX-XXXXX-…" className="min-w-64 flex-1 font-mono"/><Button variant="secondary" disabled={linking || cancelling || active || !serverUrl.trim() || !recoveryCode.trim()} onClick={() => void perform('recover')}>使用恢复码连接</Button></div><p className="mt-2 text-xs text-muted-foreground">恢复码仅用于本次连接，提交后不会显示、记录或写入磁盘。</p></div>
      <p className="text-xs text-muted-foreground">使用 Paws 正常扫码授权；凭据只保留在此服务内存。{active ? '先停止所有协调，才能断开或切换账号。' : ''}</p>
      {(error || status.error) && <p role="alert" className="text-destructive">{error || status.error}</p>}
    </div>
  </details>;
}
