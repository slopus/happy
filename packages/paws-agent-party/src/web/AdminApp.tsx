import { BarChart3, Gauge, Settings2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { bootstrapToken, createApi } from './api.js';

type Policy = { enabled: boolean; tokenLimit: number | null; allowImages: boolean; allowAutoDebate: boolean; maxConcurrentVisitors: number };
type Dashboard = { ownerAccountId?: string; visitors: { total: number; active24h: number }; usage: { estimatedTokens: number; note: string }; policy: Policy; guestExecutorReady: boolean };

export function AdminApp() {
  const [token, setToken] = useState(() => bootstrapToken(window.location, window.history, sessionStorage));
  const [draft, setDraft] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const api = useMemo(() => createApi(() => token, () => setToken('')), [token]);
  const load = async () => {
    try { const next = await api<Dashboard>('/api/admin/dashboard'); setDashboard(next); setPolicy(next.policy); setError(''); }
    catch (cause) { setDashboard(null); setError((cause as Error).message); }
  };
  useEffect(() => { if (token) void load(); }, [token]);
  if (!token) return <main className="admin-gate"><form onSubmit={event => { event.preventDefault(); if (draft.trim()) { sessionStorage.setItem('apToken', draft.trim()); setToken(draft.trim()); } }}><h1>AgentParty 管理后台</h1><p>使用服务管理员令牌，或从 Paws 内直接打开。</p><input aria-label="服务管理员令牌" value={draft} onChange={event => setDraft(event.target.value)} placeholder="管理员令牌"/><button>进入后台</button>{error && <p role="alert">{error}</p>}</form></main>;
  return <main className="admin-shell"><header className="admin-header"><a href="../">AgentParty</a><div><strong>管理后台</strong><button onClick={() => { sessionStorage.removeItem('apToken'); setToken(''); }}>退出</button></div></header>{error && <p role="alert" className="admin-error">{error}</p>}{!dashboard || !policy ? <p className="admin-loading">正在读取管理数据…</p> : <><section className="admin-intro"><div><span>访问与额度</span><h1>访客策略</h1><p>访客与所有者的群聊、Agent 和设备完全分开。访客执行器尚未配置前，不会接入任何所有者设备。</p></div><button onClick={() => void load()}>刷新数据</button></section><section className="admin-metrics"><Metric icon={<Users/>} label="累计访客" value={dashboard.visitors.total}/><Metric icon={<BarChart3/>} label="近 24 小时" value={dashboard.visitors.active24h}/><Metric icon={<Gauge/>} label="估算 Token" value={dashboard.usage.estimatedTokens.toLocaleString()}/></section><p className="admin-note">{dashboard.usage.note}</p><section className="admin-grid"><article className="admin-card"><div className="admin-card-title"><Settings2/><h2>访客访问策略</h2></div><label className="admin-switch"><input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({ ...policy, enabled: event.target.checked })}/><span>允许访客模式</span></label><label>每位访客的 Token 配额<select aria-label="每位访客的 Token 配额" value={policy.tokenLimit ?? 'unlimited'} onChange={event => setPolicy({ ...policy, tokenLimit: event.target.value === 'unlimited' ? null : Number(event.target.value) })}><option value={2_000}>2,000</option><option value={20_000}>20,000</option><option value={50_000}>50,000</option><option value={200_000}>200,000（默认）</option><option value="unlimited">不限额</option></select></label><label>同时在线访客<select aria-label="同时在线访客" value={policy.maxConcurrentVisitors} onChange={event => setPolicy({ ...policy, maxConcurrentVisitors: Number(event.target.value) })}>{[1, 2, 4, 8, 16, 32].map(value => <option key={value} value={value}>{value} 位</option>)}</select></label><label className="admin-switch"><input type="checkbox" checked={policy.allowImages} onChange={event => setPolicy({ ...policy, allowImages: event.target.checked })}/><span>允许上传图片</span></label><label className="admin-switch"><input type="checkbox" checked={policy.allowAutoDebate} onChange={event => setPolicy({ ...policy, allowAutoDebate: event.target.checked })}/><span>允许自动辩论</span></label><button className="admin-save" disabled={saving} onClick={async () => { setSaving(true); try { const saved = await api<Policy>('/api/admin/policy', { method: 'PATCH', body: JSON.stringify(policy) }); setPolicy(saved); await load(); } catch (cause) { setError((cause as Error).message); } finally { setSaving(false); } }}>{saving ? '保存中…' : '保存策略'}</button></article><article className="admin-card"><h2>访客执行器</h2><p className={dashboard.guestExecutorReady ? 'admin-good' : 'admin-warn'}>{dashboard.guestExecutorReady ? '已就绪' : '尚未配置'}</p><p>访客不能复用管理员的 Paws 账号、Agent、群聊或机器。配置独立执行器后，访客模式才会真正开放。</p><p className="admin-note">当前开启策略只会记录访客入口；不会把访客请求发送到你的设备。</p></article></section></>}</main>;
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) { return <article><span>{icon}</span><small>{label}</small><strong>{value}</strong></article>; }
