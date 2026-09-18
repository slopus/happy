import { useEffect, useRef, useState } from 'react';
import type { BrowseDirectoryResult, SessionConfiguration } from '@wangjs-jacky/paws-agent';
import type { AgentProfileInput } from '../group-chat/profiles.js';
import type { MachinesResponse } from '../contracts.js';
import { CODEX_EFFORTS, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT, type CodexEffort } from '../group-chat/codex-profile.js';
import { AvatarPicker, RobotAvatar } from './RobotAvatar.js';
import { machineLabel } from './machine-label.js';
import type { Api } from './api.js';

// Same configured fallback candidates as Happy's getCodexModelModes (not device capabilities).
const PAWS_CODEX_CANDIDATES = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];
export type ConfigurationSession = { sessionId: string; machineId: string };
export function ProfileEditor({ initial, machines, sessions, api, onSave, submitLabel = '保存 Agent' }: {
  initial?: AgentProfileInput; machines: MachinesResponse['machines']; sessions: ConfigurationSession[]; api: Api;
  onSave(value: AgentProfileInput): Promise<void>; submitLabel?: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [avatarId, setAvatarId] = useState(initial?.avatarId ?? 0);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [machineId, setMachineId] = useState(initial?.machineId ?? '');
  const [directory, setDirectory] = useState(initial?.directory ?? '');
  const [model, setModel] = useState(initial?.model ?? DEFAULT_CODEX_MODEL);
  const [effort, setEffort] = useState<CodexEffort>(initial?.effort ?? DEFAULT_CODEX_EFFORT);
  const [catalog, setCatalog] = useState<SessionConfiguration | null>(null);
  const [catalogState, setCatalogState] = useState('');
  const [listing, setListing] = useState<Extract<BrowseDirectoryResult, { success: true }> | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const browseRequest = useRef<{ controller: AbortController; machineId: string; sequence: number } | null>(null);
  const browseSequence = useRef(0);
  const sessionId = sessions.find(session => session.machineId === machineId)?.sessionId;
  useEffect(() => () => browseRequest.current?.controller.abort(), []);
  useEffect(() => {
    browseRequest.current?.controller.abort(); browseRequest.current = null; browseSequence.current += 1;
    setBrowsing(false); setCatalog(null); setCatalogState(''); setListing(null);
    if (!machineId) return;
    const controller = new AbortController();
    setCatalogState('读取设备配置…');
    void api<({ available: true } & SessionConfiguration) | { available: false; reason: string }>(`/api/paws/machines/${encodeURIComponent(machineId)}/configuration${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      if (value.available) { setCatalog(value); setCatalogState('已读取此设备现有会话的模型选项。'); }
      else setCatalogState('尚无可读取的会话目录；下列为 Paws 预设候选，实际支持以远端 Codex 为准。');
    }).catch(() => { if (!controller.signal.aborted) setCatalogState('未能读取实时模型目录，当前显示 Paws 预设候选。'); });
    return () => controller.abort();
  }, [api, machineId, sessionId]);
  const modelOptions = catalog?.models.length ? catalog.models : PAWS_CODEX_CANDIDATES.map(code => ({ code, label: code }));
  const models = modelOptions.some(item => item.code === model) ? modelOptions : [{ code: model, label: `${model}（已保存）` }, ...modelOptions];
  // SDK efforts describe the current session model only, never reuse them for another model.
  const efforts = catalog?.model === model && catalog.efforts.length ? catalog.efforts.filter(item => CODEX_EFFORTS.includes(item.code as CodexEffort)) : CODEX_EFFORTS.map(code => ({ code, label: code }));
  useEffect(() => { if (efforts.length && !efforts.some(item => item.code === effort)) setEffort(efforts[0].code as CodexEffort); }, [catalog, model, effort]);
  const browse = async (path?: string) => {
    browseRequest.current?.controller.abort();
    const controller = new AbortController(); const selectedMachine = machineId; const sequence = ++browseSequence.current;
    browseRequest.current = { controller, machineId: selectedMachine, sequence };
    setBrowsing(true); setError('');
    try { const result = await api<BrowseDirectoryResult>(`/api/paws/machines/${encodeURIComponent(selectedMachine)}/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`, { signal: controller.signal });
      if (controller.signal.aborted || browseRequest.current?.sequence !== sequence || browseRequest.current.machineId !== selectedMachine) return;
      if (!result.success) throw new Error(result.error); setListing(result);
    } catch (error) { if (!controller.signal.aborted && browseRequest.current?.sequence === sequence) setError((error as Error).message); }
    finally { if (browseRequest.current?.sequence === sequence) { browseRequest.current = null; setBrowsing(false); } }
  };
  return <form className="profile-form" onSubmit={async event => {
    event.preventDefault(); if (saving) return; setSaving(true); setError('');
    try { await onSave({ name, instructions, avatarId, machineId, directory: directory.trim(), model, effort, engine: 'codex' }); }
    catch (error) { setError((error as Error).message); } finally { setSaving(false); }
  }}>
    <div className="detail-profile"><RobotAvatar id="preview" avatarId={avatarId} large/><button type="button" onClick={() => setAvatarOpen(value => !value)}>选择机器人</button></div>
    {avatarOpen && <AvatarPicker value={avatarId} onChange={value => { setAvatarId(value); setAvatarOpen(false); }}/>}<label>Agent 名称<input required maxLength={40} value={name} onChange={event => setName(event.target.value)}/></label>
    <label>角色与关注点<textarea required maxLength={4000} value={instructions} onChange={event => setInstructions(event.target.value)}/></label>
    <label>执行设备<select required value={machineId} onChange={event => { setMachineId(event.target.value); setDirectory(''); }}><option value="">选择设备</option>{machineId && !machines.some(machine => machine.id === machineId) && <option value={machineId}>已保存的设备（当前离线）</option>}{machines.map(machine => <option value={machine.id} key={machine.id}>{machineLabel(machine)}</option>)}</select></label>
    <label>工作目录<input required value={directory} placeholder="已授权的绝对路径" onChange={event => setDirectory(event.target.value)}/></label><button type="button" disabled={!machineId || browsing} onClick={() => void browse()}>{browsing ? '读取目录…' : '浏览远端目录'}</button>
    {listing && <div className="directory-browser"><small>{listing.path}</small><button type="button" onClick={() => { setDirectory(listing.path); setListing(null); }}>选择当前目录</button>{listing.parent && <button type="button" onClick={() => void browse(listing.parent!)}>↑ 上一级</button>}{listing.directories.map(item => <button type="button" key={item.path} onClick={() => void browse(item.path)}>▸ {item.name}</button>)}</div>}
    <p className="muted">浏览目录不等于授权。首次运行若请求权限，请在 Paws 中批准。</p>
    <div className="form-columns"><label>Codex 模型<select value={model} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label><label>思考强度<select value={effort} onChange={event => setEffort(event.target.value as CodexEffort)}>{efforts.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label></div>
    <p className="muted">{catalogState || '先选择执行设备。'} 修改默认配置只影响之后邀请的成员，不改变已有群聊的执行会话。</p>
    {error && <p role="alert">{error}</p>}<button className="primary-action" disabled={saving || !machineId || !directory.trim().startsWith('/')}>{saving ? '保存中…' : submitLabel}</button>
  </form>;
}
