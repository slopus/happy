import type { Machine } from '@wangjs-jacky/paws-agent';
import { useRef, useState } from 'react';
import { ROLE_IDS, type Engine, type ImageRef, type RunSnapshot, type StartInput } from '../contracts.js';
import { PartyComposer } from '../../vendor/agents-party/src/ui/party/composer.js';
import { Button } from '../../vendor/agents-party/src/ui/components/button.js';
import { Input } from '../../vendor/agents-party/src/ui/components/input.js';
import { Attachments } from './Attachments.js';
import { ApiError, type Api } from './api.js';
import { useDialogFocus } from './modalFocus.js';

export const statusLabel: Record<string, string> = { running: '执行中', queued: '排队中', completed: '已完成', failed: '失败', stopped: '已停止协调', interrupted: '已中断（未重放）', pending: '待执行', spawning: '创建会话中', 'not-selected': '未选择' };
export const isActive = (run: RunSnapshot) => run.status === 'running' || run.followUps.some(item => item.status === 'running' || item.status === 'queued');

export function RunStatus({ run, onStop }: { run: RunSnapshot; onStop: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="flex flex-col gap-1 text-xs" aria-live="polite">
    <span>会诊：{statusLabel[run.status]} · {run.phase}</span>
    {run.followUps.map(item => <span key={item.requestId}>追问：{statusLabel[item.status]}{item.error ? ` · ${item.error}` : ''}</span>)}
    {run.error && <span className="text-destructive">{run.error}</span>}
    <span className="text-muted-foreground">停止仅结束协调与观察，远端可能继续。关闭网页不会停止任务。</span>
    {isActive(run) && <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
      setBusy(true); setError(''); void onStop().catch(error => setError((error as Error).message)).finally(() => setBusy(false));
    }}>{busy ? '停止中…' : '停止协调'}</Button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}

export function StartConsultation({ ready, machines, api, onStarted, onClose }: {
  ready: boolean; machines: Machine[]; api: Api; onStarted: (run: RunSnapshot) => void; onClose: () => void;
}) {
  const dialog = useDialogFocus(true, onClose);
  const [stock, setStock] = useState('');
  const [machineId, setMachineId] = useState('');
  const [directory, setDirectory] = useState('');
  const [mode, setMode] = useState<'single' | 'consultation'>('single');
  const [images, setImages] = useState<ImageRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [agents, setAgents] = useState<Record<(typeof ROLE_IDS)[number], Engine>>({ moderator: 'codex', trend30: 'codex', structure10: 'codex', timing1: 'codex' });
  // Retry of an ambiguous HTTP response keeps the same requestId and payload.
  const pending = useRef<StartInput | null>(null);
  const reason = !ready ? '先连接 Paws 账号。' : !stock.trim() ? '填写标的名称（使用 Mock 行情）。' : !machineId ? '选择在线机器。' : !directory.trim() ? '明确填写工作目录。' : uploading ? '图片上传中。' : '';
  return <div className="modal-backdrop"><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="新建会诊" className="modal-card">
    <header className="flex items-center justify-between"><h2 className="font-title text-xl">新建会诊</h2><Button variant="ghost" onClick={onClose}>关闭</Button></header>
    <p className="text-sm">Mock 行情 · 合成数据，不构成投资建议</p>
    <label>标的<Input value={stock} onChange={event => setStock(event.target.value)} /></label>
    <label>机器<select value={machineId} onChange={event => setMachineId(event.target.value)}><option value="">请选择机器</option>{machines.filter(machine => machine.active).map(machine => <option key={machine.id} value={machine.id}>{machine.id}</option>)}</select></label>
    <label>工作目录<Input placeholder="绝对路径，由你明确指定" value={directory} onChange={event => setDirectory(event.target.value)} /></label>
    <label>模式<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="single">单 Agent 连接检查</option><option value="consultation">完整会诊（8 轮）</option></select></label>
    <div className="grid grid-cols-2 gap-2">{ROLE_IDS.map(role => <label key={role}>{role}<select disabled={mode === 'single' && role !== 'moderator'} value={agents[role]} onChange={event => setAgents({ ...agents, [role]: event.target.value as Engine })}>{(['codex', 'claude', 'gemini', 'opencode'] as const).map(engine => <option key={engine}>{engine}</option>)}</select></label>)}</div>
    <Attachments images={images} onChange={setImages} api={api} onBusy={setUploading} />
    <p role="status" className="text-sm text-muted-foreground">{reason || '可发送文字、图片或混合输入。'}</p>
    <PartyComposer disabled={!!reason} hasContent={images.length > 0} placeholder="说明你的问题，也可只发送图片…" onSend={async text => {
      const candidate: StartInput = { requestId: pending.current?.requestId ?? crypto.randomUUID(), stock: stock.trim(), text, images, machineId, directory: directory.trim(), agents, mode };
      const payload = pending.current ?? candidate;
      pending.current = payload;
      try {
        const run = await api<RunSnapshot>('/api/consultations', { method: 'POST', body: JSON.stringify(payload) });
        pending.current = null; setUncertain(false); onStarted(run);
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) { pending.current = null; setUncertain(false); }
        else setUncertain(true);
        throw error;
      }
    }} />
    {uncertain && <p role="status" className="text-xs">提交结果未确认。重试会使用上次提交内容与请求编号，避免重复启动；可先关闭此窗口检查会诊列表。</p>}
  </section></div>;
}
