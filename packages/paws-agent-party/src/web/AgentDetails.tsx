import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@wangjs-jacky/paws-agent';
import type { AgentMessagesResponse, RunSnapshot, RoleId } from '../contracts.js';
import type { Api } from './api.js';
import { Button } from '../../vendor/agents-party/src/ui/components/button.js';
import { statusLabel } from './Consultation.js';
import { useDialogFocus, useNarrowDetails } from './modalFocus.js';

export function AgentDetails({ run, role, api, onClose }: { run: RunSnapshot; role: RoleId; api: Api; onClose: () => void }) {
  const narrow = useNarrowDetails();
  const dialog = useDialogFocus(narrow, onClose);
  const [messages, setMessages] = useState<Message[]>([]);
  const [page, setPage] = useState<AgentMessagesResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const sessionId = run.roles[role].sessionId;
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const next = await api<AgentMessagesResponse>(`/api/consultations/${run.id}/agents/${role}/messages?afterSeq=${cursor.current}`);
      if (!alive.current) return;
      cursor.current = next.messages.reduce((seq, message) => Math.max(seq, message.seq), cursor.current);
      setMessages(previous => [...new Map([...previous, ...next.messages].map(message => [message.id, message])).values()].sort((a, b) => a.seq - b.seq));
      setPage(next);
    } catch (error) { if (alive.current) setError((error as Error).message); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }, [api, run.id, role]);
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; };
  }, [load]);
  return <section ref={dialog} tabIndex={-1} role="dialog" aria-modal={narrow ? true : undefined} aria-label="执行详情" className="agent-details">
    <header className="flex items-center justify-between"><h2 className="font-title text-lg">执行详情 · {role}</h2><Button variant="ghost" onClick={onClose}>关闭详情</Button></header>
    <p>{statusLabel[run.roles[role].status] ?? run.roles[role].status}</p>
    <p className="break-all">sessionId：{sessionId ?? '会话尚未创建；停止后晚到的会话仍会保留。'}</p>
    {sessionId && <a className="text-link underline" href={`https://47.115.228.20:8443/session/${encodeURIComponent(sessionId)}`} target="_blank" rel="noreferrer">在 Paws 打开原始会话</a>}
    <p className="text-xs text-muted-foreground">停止只结束协调，远端可能继续。这里只显示已收到的持久化记录，不保证存在隐藏推理。</p>
    <h3 className="font-semibold">每轮来源关联</h3>
    {run.turns.filter(turn => turn.participant === role).map(turn => <details key={turn.taskMessageId} open className="rounded border border-border p-2 text-xs">
      <summary>任务 → 公开回复 → SDK 完成事件</summary>
      <dl className="break-all">{Object.entries(turn).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{key === 'sourceMessageId' ? 'sourceMessageId（turn-end 记录）' : key}</dt><dd>{value}</dd></div>)}</dl>
    </details>)}
    {!!page?.requests.length && <div role="status" className="rounded border border-border p-2">待授权：请在原始 Paws 会话处理，本页面不会自动批准。{page.requests.map(request => <details key={request.id}><summary>{request.type} · {request.id}</summary><pre>{JSON.stringify(request.payload, null, 2)}</pre></details>)}</div>}
    <h3 className="font-semibold">持久化执行记录</h3>
    {messages.map(message => <details key={message.id} className="rounded border border-border p-2 text-xs"><summary>#{message.seq} · {eventSummary(message.content)}</summary><pre className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(message, null, 2)}</pre></details>)}
    {!busy && !messages.length && !error && <p>暂无可读取的记录。</p>}
    {error && <p role="alert" className="text-destructive">详情读取失败：{error}。检查连接后重试。</p>}
    <Button disabled={busy} variant="secondary" onClick={() => void load()}>{busy ? '加载中…' : page?.hasMore ? '加载下一页' : '刷新记录'}</Button>
  </section>;
}

function eventSummary(content: unknown): string {
  const value = content as { role?: string; content?: { ev?: { t?: string; status?: string; thinking?: boolean } } } | null;
  const event = value?.role === 'session' ? value.content?.ev : undefined;
  if (event) return `${event.t ?? '事件'}${event.status ? ` · ${event.status}` : ''}${event.thinking ? ' · 私有思考标记' : ''}`;
  return value?.role === 'user' ? '用户提交回声' : '原始记录';
}
