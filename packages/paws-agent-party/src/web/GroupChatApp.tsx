import { MessageCircle, Plus, Users, PanelLeftClose, PanelLeftOpen, MoreHorizontal, Trash2, X, HelpCircle, UserRound, Link2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, PartyMeta } from '../../vendor/agents-party/src/core/types.js';
import type { AgentMessagesResponse, ConnectionStatus, MachinesResponse } from '../contracts.js';
import type { AgentProfile } from '../group-chat/profiles.js';
import type { GroupRoomSnapshot } from '../group-chat/rooms.js';
import { bootstrapToken, createApi } from './api.js';
import { decrypt } from './lib/crypto.js';
import { ConnectionPanel } from './ConnectionPanel.js';
import { GroupComposer, type ComposerDraft } from './GroupComposer.js';
import { RobotAvatar } from './RobotAvatar.js';
import { RemoteDirectoryPicker } from './RemoteDirectoryPicker.js';
import { ProfileEditor, type ConfigurationSession } from './ProfileEditor.js';
import { AssetImage, decodeEnvelope } from './Attachments.js';
import { machineLabel } from './machine-label.js';
import { displayAvatarId } from './display-avatar.js';
import './group-workbench.css';
import { useDialogFocus } from './modalFocus.js';
import { mergeRooms, reconcileRoomList, timelineMessages, watchGroupRoom, type VisibleMessage } from './group-stream.js';

type OwnerParty = Pick<PartyMeta, 'key'>;
export function GroupChatApp() {
  const [token, setToken] = useState(() => bootstrapToken(window.location, window.history, sessionStorage));
  const [gate, setGate] = useState(!token); const [draftToken, setDraftToken] = useState('');
  const [connection, setConnection] = useState<ConnectionStatus>({ state: 'disconnected' });
  const [machines, setMachines] = useState<MachinesResponse['machines']>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]); const [rooms, setRooms] = useState<GroupRoomSnapshot[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ roomId: string; messages: VisibleMessage[] } | null>(null);
  const selectedRoom = useRef(roomId); selectedRoom.current = roomId;
  const messageRequest = useRef(0);
  const messageEpoch = useRef(0);
  const appliedMessageRequest = useRef(0);
  const timeline = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const [showAgent, setShowAgent] = useState(false); const [showRoom, setShowRoom] = useState(false); const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [sendingRooms, setSendingRooms] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [membersRendered, setMembersRendered] = useState(false);
  const [menuRoom, setMenuRoom] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<GroupRoomSnapshot | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deletedRooms = useRef(new Set<string>());
  const roomMutationEpoch = useRef(0);
  const [help, setHelp] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [mentionRequest, setMentionRequest] = useState(0);
  const [detailMember, setDetailMember] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);
  const api = useMemo(() => createApi(() => token, () => setGate(true)), [token]);
  const room = rooms.find(value => value.id === roomId) ?? null;
  const draft = room ? drafts[room.id] ?? { text: '', images: [] } : { text: '', images: [] };
  const changeDraft = (value: ComposerDraft) => { if (room) setDrafts(current => ({ ...current, [room.id]: value })); };
  const partyId = room?.partyId;
  const configurationSessions: ConfigurationSession[] = rooms.flatMap(item => item.members.flatMap(member => member.sessionId ? [{ sessionId: member.sessionId, machineId: member.machineId ?? item.machineId }] : []));
  const messages = useMemo(() => room ? timelineMessages(room, history?.roomId === room.id ? history.messages : []) : [], [room, history]);
  useLayoutEffect(() => { followOutput.current = true; }, [roomId]);
  useLayoutEffect(() => { if (followOutput.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight; }, [messages]);
  const refresh = useCallback(async () => {
    const mutationEpoch = roomMutationEpoch.current;
    const [status, agentResult, roomResult] = await Promise.all([api<ConnectionStatus>('/api/paws/status'), api<{ agents: AgentProfile[] }>('/api/group-chat/agents'), api<{ rooms: GroupRoomSnapshot[] }>('/api/group-chat/rooms')]);
    setConnection(status); setAgents(agentResult.agents); if (mutationEpoch === roomMutationEpoch.current) setRooms(current => reconcileRoomList(current, roomResult.rooms).filter(item => !deletedRooms.current.has(item.id))); if (status.state === 'ready') setMachines((await api<MachinesResponse>('/api/paws/machines')).machines); else setMachines([]);
  }, [api]);
  useEffect(() => { if (gate || !token) return; void refresh().catch(error => setError((error as Error).message)); const timer = setInterval(() => void refresh().catch(() => undefined), 1800); return () => clearInterval(timer); }, [gate, token, refresh]);
  useEffect(() => { if (!room && rooms[0]) setRoomId(rooms[0].id); }, [room, rooms]);
  useEffect(() => {
    if (gate || !token || !roomId) return;
    const controller = new AbortController();
    void watchGroupRoom({ roomId, token, signal: controller.signal, onUnauthorized: () => setGate(true), onSnapshot: snapshot => { if (!deletedRooms.current.has(snapshot.id)) setRooms(current => mergeRooms(current, [snapshot])); } });
    return () => controller.abort();
  }, [roomId, token, gate]);
  const refreshMessages = useCallback(async () => {
    if (!roomId || !partyId) return;
    const request = ++messageRequest.current;
    const epoch = messageEpoch.current;
    const party = await api<OwnerParty>(`/api/parties/${partyId}`); const key = party.key; if (!key) throw new Error('This group party has no owner key.'); const body = await api<{ messages: Message[] }>(`/api/parties/${partyId}/messages?limit=100`);
    const decoded = await Promise.all(body.messages
      .filter(item => item.kind === 'message' && item.to === '*')
      .map(async item => { const text = await decrypt(key, item.text); const envelope = decodeEnvelope(text); return { id: item.id, from: item.from, replyTo: item.replyTo, text: envelope?.text ?? text, images: envelope?.images ?? [], ts: item.ts }; }));
    if (selectedRoom.current === roomId && epoch === messageEpoch.current && request > appliedMessageRequest.current) {
      appliedMessageRequest.current = request;
      setHistory({ roomId, messages: decoded.flatMap(item => item.text === null ? [] : [{ ...item, text: item.text }]) });
    }
  }, [api, roomId, partyId]);
  useEffect(() => { if (gate) return; void refreshMessages().catch(() => undefined); const timer = setInterval(() => void refreshMessages().catch(() => undefined), 1600); return () => { clearInterval(timer); messageEpoch.current++; }; }, [refreshMessages, gate]);
  const publishedIds = room?.turns.map(turn => turn.publicMessageId ?? '').join(',');
  useEffect(() => { if (!gate) void refreshMessages().catch(() => undefined); }, [publishedIds, refreshMessages, gate]);
  const sendLocks = useRef(new Set<string>());
  const send = async () => {
    if (!room || (!draft.text.trim() && !draft.images.length) || sendLocks.current.has(room.id)) return;
    const id = room.id; const submitted = draft;
    sendLocks.current.add(id); setSendingRooms(new Set(sendLocks.current)); setError('');
    try {
      await api(`/api/group-chat/rooms/${id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), ...submitted }) });
      setDrafts(current => current[id] === submitted ? { ...current, [id]: { text: '', images: [] } } : current);
      await refreshMessages();
    } catch (error) { if (selectedRoom.current === id) setError((error as Error).message); }
    finally { sendLocks.current.delete(id); setSendingRooms(new Set(sendLocks.current)); }
  };
  // Reset the previous room's overlays before the new room is interactive.
  // A passive effect can otherwise overwrite a click made as the new header appears.
  useLayoutEffect(() => { setMembersOpen(false); setDetailMember(null); setInvite(false); setMenuRoom(null); setError(''); setMentionRequest(0); }, [roomId]);
  useEffect(() => {
    if (membersOpen) { setMembersRendered(true); return; }
    const timer = setTimeout(() => setMembersRendered(false), 200); return () => clearTimeout(timer);
  }, [membersOpen]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMembersOpen(false); setMenuRoom(null); } };
    document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape);
  }, []);
  const deleteRoom = async () => {
    if (!deleting || deleteBusy) return; const id = deleting.id; roomMutationEpoch.current += 1; setDeleteBusy(true); setError('');
    try { await api(`/api/group-chat/rooms/${id}`, { method: 'DELETE' }); roomMutationEpoch.current += 1; deletedRooms.current.add(id); setRooms(current => current.filter(item => item.id !== id)); if (selectedRoom.current === id) setRoomId(rooms.find(item => item.id !== id)?.id ?? null); setDeleting(null); }
    catch (error) { setError((error as Error).message); } finally { setDeleteBusy(false); }
  };
  const activeOrdinaryWork = !!room && room.debate?.status !== 'running' && room.members.some(member => member.status === 'spawning' || member.status === 'running');
  const stopRoom = async () => { if (!room) return; setError(''); try { await api(`/api/group-chat/rooms/${room.id}/stop`, { method: 'POST', body: '{}' }); await refresh(); } catch (error) { setError((error as Error).message); } };
  if (gate) return <TokenGate value={draftToken} setValue={setDraftToken} submit={() => { const value = draftToken.trim(); if (!value) return; sessionStorage.setItem('apToken', value); setToken(value); setGate(false); }} />;
  return <main className={`group-workbench${collapsed ? ' sidebar-collapsed' : ''}`}>
    <aside className="workbench-sidebar">
      <div className="workbench-brand"><span className="brand-mark" aria-hidden="true"><i/><i/></span><h1>AgentParty</h1><button className="collapse-button" aria-label={collapsed ? '展开侧栏' : '折叠侧栏'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}</button></div>
      <nav aria-label="工作台导航" className="workbench-nav"><button className="nav-current" title="群聊" onClick={() => setCollapsed(false)}><MessageCircle size={19}/><span>群聊</span><span className="nav-count">{rooms.length}</span></button><button title="Agent 管理" onClick={() => setShowAgent(true)}><Users size={19}/><span>Agent 管理</span><span className="nav-count">{agents.length}</span></button></nav>
      <div className="room-list-heading"><span>我的群聊</span><button aria-label="新建群聊" title="新建群聊" onClick={() => setShowRoom(true)}><Plus size={18}/></button></div>
      <nav aria-label="我的群聊" className="workbench-rooms">{rooms.map(item => <div className="room-row" key={item.id}><button className="room-select" title={item.title} aria-current={item.id === room?.id ? 'page' : undefined} onClick={() => setRoomId(item.id)}><MessageCircle className="room-rail-icon" size={18}/><strong>{item.title}</strong><span>{item.members.length} 位 Agent · {item.autoReply ? '自动接话' : '仅 @ 回复'}</span></button><button className="room-more" aria-label={`${item.title} 的更多操作`} aria-expanded={menuRoom === item.id} onClick={() => setMenuRoom(menuRoom === item.id ? null : item.id)}><MoreHorizontal size={18}/></button>{menuRoom === item.id && <div className="room-menu"><button onClick={() => { setDeleting(item); setMenuRoom(null); setError(''); }}><Trash2 size={15}/>删除群聊</button></div>}</div>)}</nav>
      <button className="sidebar-foot" title="Paws 连接设置" onClick={() => setConnectionOpen(true)}><span className={`connection-dot ${connection.state === 'ready' ? 'is-ready' : ''}`}/><span>{connection.state === 'ready' ? 'Paws 已连接' : '连接 Paws'}</span><Link2 size={15}/></button>
    </aside>
    <div className="workbench-main">
      {!room ? <EmptyState onCreate={() => setShowRoom(true)}/> : <section className="workbench-room">
        <header className="room-header"><div className="room-heading"><h2>{room.title}</h2><span>{room.members.length} 位成员</span></div><div className="room-actions">{activeOrdinaryWork && <button className="danger" title="停止本地协调；远端已接受的工作可能继续" onClick={() => void stopRoom()}>停止协调</button>}<button aria-pressed={room.autoReply} title="未 @ 时由一位相关成员回复" onClick={() => void updateRoom(api, room.id, { autoReply: !room.autoReply }, refresh, setError)}><span className="toggle-track" aria-hidden="true"><span/></span>自动接话</button><button aria-pressed={room.autoDebate} onClick={() => void updateRoom(api, room.id, { autoDebate: !room.autoDebate }, refresh, setError)}>自动辩论：{room.autoDebate ? '开' : '关'}</button><button aria-expanded={membersOpen} onClick={() => setMembersOpen(value => !value)}><Users size={18}/>成员 · {room.members.length}</button><button className="help-button" aria-label="群聊帮助" onClick={() => setHelp(true)}><HelpCircle size={18}/></button></div></header>
        <div className="room-body"><div className="room-conversation">{(room.autoDebate || room.debate) && <DebateStatus room={room} api={api} refresh={refresh} setError={setError}/>}
          <div ref={timeline} onScroll={event => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.clientHeight - element.scrollTop < 64; }} className="room-timeline" role="region" aria-label="群聊消息"><div className="timeline-content">{messages.length ? messages.map(message => <MessageCard key={message.taskMessageId ?? message.id} message={message} room={room} api={api} profiles={agents} onDetails={setDetailMember}/>) : <div className="timeline-empty"><div className="welcome-avatars">{room.members.slice(0, 4).map(member => <RobotAvatar key={member.id} id={member.id} avatarId={displayAvatarId(member, agents)} large/>)}</div><h3>成员已到，聊点什么？</h3><p>直接发消息，让合适的成员接话；<br/>或者在一句话里 @ 两三位，听听不同的视角。</p><button onClick={() => setMentionRequest(value => value + 1)}> @ 一位成员</button></div>}</div></div>
          <div className="room-composer"><GroupComposer key={room.id} room={room} profiles={agents} draft={draft} change={changeDraft} api={api} send={() => void send()} sending={sendingRooms.has(room.id)} mentionRequest={mentionRequest}/>{error && !deleting && <p role="alert" className="workbench-error">{error}</p>}</div>
        </div>
        {membersRendered && <><button hidden={!membersOpen} className="members-scrim" aria-label="关闭成员面板" onClick={() => setMembersOpen(false)}/><aside className={`room-members${membersOpen ? '' : ' is-closing'}`} inert={!membersOpen} aria-hidden={!membersOpen} aria-label="本群成员"><div className="members-heading"><span>本群成员 · {room.members.length}</span><button aria-label="关闭成员" onClick={() => setMembersOpen(false)}><X size={18}/></button></div><div className="member-list">{room.members.map(member => <button key={member.id} className="member-profile" onClick={() => { setDetailMember(member.id); setMembersOpen(false); }}><RobotAvatar id={member.id} avatarId={displayAvatarId(member, agents)}/><span className="member-copy"><strong>{member.name}</strong><span className="member-model">{memberStatusLabel(member.status)}{member.temporary ? ' · 临时成员' : ''}</span></span></button>)}</div><button className="invite-button" onClick={() => { setInvite(true); setMembersOpen(false); }}><Plus size={16}/>邀请成员</button></aside></>}
        </div>
      </section>}</div>
    {connectionOpen && <Modal title="Paws 连接" close={() => setConnectionOpen(false)}><ConnectionPanel status={connection} api={api} active={rooms.some(item => item.members.some(member => member.status === 'running' || member.status === 'spawning'))} onChange={setConnection}/></Modal>}
    {showAgent && <AgentDialog agents={agents} machines={machines} sessions={configurationSessions} api={api} close={() => setShowAgent(false)} refresh={refresh}/>}
    {showRoom && <RoomDialog agents={agents} machines={machines} ready={connection.state === 'ready'} api={api} close={() => setShowRoom(false)} onCreated={created => { roomMutationEpoch.current += 1; deletedRooms.current.delete(created.id); setRooms(current => mergeRooms(current, [created])); setRoomId(created.id); setShowRoom(false); }}/>}
    {deleting && <Modal title="删除群聊" close={() => { if (!deleteBusy) setDeleting(null); }}><p>删除「{deleting.title}」及本地聊天记录？此操作不可撤销。</p><p className="muted">不会删除 Agent 配置库或远端 Paws 会话。运行中的群聊须先停止协调。</p><div className="dialog-actions"><button disabled={deleteBusy} onClick={() => setDeleting(null)}>取消</button><button className="danger" disabled={deleteBusy} onClick={() => void deleteRoom()}>{deleteBusy ? '删除中…' : '确认删除'}</button></div>{error && <p role="alert">{error}</p>}</Modal>}
    {help && <Modal title="群聊帮助" close={() => setHelp(false)}><p>用 @ 点名一位或多位成员；没有 @ 时，由自动接话开关决定是否回复。</p><p>开启自动辩论后，同时 @ 至少两位成员发起。每人说一次算一轮，最多 10 轮，可随时停止协调。</p><p>消息支持图片 + 文字；公开时间线只显示发言，点击执行详情查看真实 Paws 记录。</p></Modal>}
    {detailMember && room && <MemberDetails room={room} memberId={detailMember} profiles={agents} machines={machines} api={api} close={() => setDetailMember(null)}/>}
    {invite && room && <InviteDialog room={room} agents={agents} machines={machines} sessions={configurationSessions} api={api} refresh={refresh} close={() => setInvite(false)}/>}
  </main>;
}

async function updateRoom(api: ReturnType<typeof createApi>, roomId: string, patch: { autoReply?: boolean; autoDebate?: boolean; maxRounds?: number }, refresh: () => Promise<void>, setError: (message: string) => void): Promise<void> { try { await api(`/api/group-chat/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify(patch) }); await refresh(); } catch (error) { setError((error as Error).message); } }
function DebateStatus({ room, api, refresh, setError }: { room: GroupRoomSnapshot; api: ReturnType<typeof createApi>; refresh(): Promise<void>; setError(message: string): void }) { const debate = room.debate; const running = debate?.status === 'running'; const next = debate?.nextMemberId ? room.members.find(member => member.id === debate.nextMemberId)?.name : null; const status = !debate ? '等待同时 @ 两位或更多 Agent 发起讨论。' : running ? `进行中 · 第 ${Math.min(debate.completedRounds + 1, debate.maxRounds)} / ${debate.maxRounds} 轮${next ? ` · 下一位：${next}` : ''}` : debate.status === 'completed' ? `已在第 ${debate.completedRounds} / ${debate.maxRounds} 轮结束。` : debate.status === 'stopped' ? '已停止，未再派发新回合。' : `已${debate.status === 'interrupted' ? '中断' : '失败'}${debate.stopReason ? `：${debate.stopReason}` : '。'}`; return <div className="debate-status"><div><h3>自动辩论</h3><p role="status">{status}</p></div><label className="text-sm">最多轮数<select aria-label="最大辩论轮数" value={room.maxRounds} disabled={running} onChange={event => void updateRoom(api, room.id, { maxRounds: Number(event.target.value) }, refresh, setError)} className="rounded-lg border border-input bg-background disabled:opacity-50">{Array.from({ length: 10 }, (_, index) => index + 1).map(rounds => <option key={rounds} value={rounds}>{rounds} 轮</option>)}</select></label>{running && <button onClick={() => void api(`/api/group-chat/rooms/${room.id}/debate/stop`, { method: 'POST', body: '{}' }).then(refresh).catch(error => setError((error as Error).message))} className="rounded-lg border border-destructive px-3 py-2 text-sm text-destructive">停止辩论</button>}</div>; }
export function MessageCard({ message, room, api, profiles = [], onDetails }: { message: VisibleMessage; room: GroupRoomSnapshot; api?: ReturnType<typeof createApi>; profiles?: AgentProfile[]; onDetails?(id: string): void }) {
  const memberIndex = room.members.findIndex(item => item.id === message.from);
  const member = room.members[memberIndex];
  const turn = room.turns.find(item => message.taskMessageId ? item.taskMessageId === message.taskMessageId : item.publicMessageId === message.id);
  const isHost = message.from === 'host';
  const author = isHost ? '我' : member?.name ?? message.from;
  const phase = turn?.phase === 'opening' ? '立论' : turn?.phase === 'rebuttal' ? `交锋 ${turn.round}` : null;
  const timestamp = new Date(message.ts);
  return <article className={`timeline-message ${isHost ? 'host-message' : ''}`}>
    {isHost ? <span className="host-avatar" aria-hidden="true"><UserRound size={20}/></span> : <RobotAvatar id={message.from} avatarId={member ? displayAvatarId(member, profiles) : undefined}/>}
    <div className="message-content"><div className="message-meta"><strong>{author}</strong>{member && <><span className="message-tag">Codex</span><span className="message-tag">{member.model}</span></>}{phase && <span className="message-tag">{phase}</span>}<time dateTime={timestamp.toISOString()} title={timestamp.toLocaleString('zh-CN')}>{timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><p className="message-text">{message.text || (message.live?.status === 'running' ? '等待 Agent 输出…' : '')}</p>{api && message.images?.map(image => <AssetImage key={image.id} image={image} api={api}/>)}{message.live && <p className={`message-live-state ${message.live.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} role={message.live.status === 'failed' ? 'alert' : undefined}>{message.live.status === 'running' ? '正在回复' : message.live.status === 'completed' ? '回复已完成' : memberStatusLabel(message.live.status)}{message.live.error ? `：${message.live.error}` : ''}</p>}{member && onDetails && <button className="execution-link" onClick={() => onDetails(member.id)}>查看执行详情 ↗</button>}</div>
  </article>;
}
function memberStatusLabel(status: GroupRoomSnapshot['members'][number]['status']): string { return ({ idle: '待命', spawning: '启动中', running: '进行中', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断' } as const)[status]; }
function EmptyState({ onCreate }: { onCreate(): void }) { return <section className="flex flex-col items-center justify-center gap-4"><div className="rounded-2xl bg-accent p-5"><MessageCircle size={30}/></div><h2 className="font-accent text-xl">从一个群聊开始</h2><p className="max-w-sm text-center text-sm text-muted-foreground">先配置可复用的 Agent，再把需要的成员拉进一个讨论空间。</p><button className="rounded-xl bg-primary px-4 py-2 text-primary-foreground" onClick={onCreate}>新建群聊</button></section>; }
function TokenGate({ value, setValue, submit }: { value: string; setValue(value: string): void; submit(): void }) { return <main className="flex min-h-screen items-center justify-center bg-muted p-6"><form onSubmit={event => { event.preventDefault(); submit(); }} className="w-full max-w-md rounded-2xl border border-border bg-card p-7 shadow-sm"><h1 className="font-accent text-xl">打开 AgentParty</h1><p className="mt-2 text-sm text-muted-foreground">输入此服务生成的访问令牌后继续。</p><input value={value} onChange={event => setValue(event.target.value)} className="mt-5 w-full rounded-lg border border-input bg-background p-3" placeholder="访问令牌"/><button className="mt-3 w-full rounded-lg bg-primary py-3 text-primary-foreground">进入工作台</button></form></main>; }
function AgentDialog({ agents, machines, sessions, api, close, refresh }: { agents: AgentProfile[]; machines: MachinesResponse['machines']; sessions: ConfigurationSession[]; api: ReturnType<typeof createApi>; close(): void; refresh(): Promise<void> }) {
  const [editing, setEditing] = useState<AgentProfile | 'new' | null>(null);
  return <Modal title="管理 Agent" close={close}>
    {editing ? <><button onClick={() => setEditing(null)}>← 返回我的 Agent</button><ProfileEditor key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} machines={machines} sessions={sessions} api={api} onSave={async value => {
      await api(editing === 'new' ? '/api/group-chat/agents' : `/api/group-chat/agents/${editing.id}`, { method: editing === 'new' ? 'POST' : 'PATCH', body: JSON.stringify(value) }); await refresh(); setEditing(null);
    }}/></> : <><p className="muted">每位 Agent 独立设置角色、设备和执行配置。已有群聊保留邀请时的执行快照。</p>{agents.map(agent => <button className="profile-summary" key={agent.id} onClick={() => setEditing(agent)}><RobotAvatar id={agent.id} avatarId={agent.avatarId}/><span><strong>{agent.name}</strong><small>{agent.machineId ? machineLabel(machines.find(machine => machine.id === agent.machineId) ?? { id: agent.machineId, active: false } as MachinesResponse['machines'][number]) : '尚未配置设备'} · {agent.model} · {agent.effort}</small></span></button>)}<button className="primary-action" onClick={() => setEditing('new')}>添加 Codex Agent</button></>}
  </Modal>;
}
function RoomDialog({ agents, machines, ready, api, close, onCreated }: { agents: AgentProfile[]; machines: MachinesResponse['machines']; ready: boolean; api: ReturnType<typeof createApi>; close(): void; onCreated(room: GroupRoomSnapshot): void }) {
  const [title, setTitle] = useState('新的讨论'); const [selected, setSelected] = useState<string[]>(agents.map(agent => agent.id));
  const [machineId, setMachineId] = useState(''); const [directory, setDirectory] = useState('');
  const [autoReply, setAutoReply] = useState(true); const [autoDebate, setAutoDebate] = useState(false); const [maxRounds, setMaxRounds] = useState(10);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const requestId = useRef(crypto.randomUUID());
  const chosen = agents.filter(agent => selected.includes(agent.id));
  const fallback = chosen.some(agent => !agent.machineId || !agent.directory);
  const first = chosen[0]; const resolvedMachine = fallback ? machineId : first?.machineId; const resolvedDirectory = fallback ? directory.trim() : first?.directory;
  return <Modal title="新建群聊" close={close}><form className="profile-form" onSubmit={async event => {
    event.preventDefault(); if (busy || !ready || !selected.length || !resolvedMachine || !resolvedDirectory?.startsWith('/')) return; setBusy(true); setError('');
    try { const created = await api<GroupRoomSnapshot>('/api/group-chat/rooms', { method: 'POST', body: JSON.stringify({ requestId: requestId.current, title, memberIds: selected, machineId: resolvedMachine, directory: resolvedDirectory, autoReply, autoDebate, maxRounds }) }); onCreated(created); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <label>群聊名称<input required value={title} onChange={event => setTitle(event.target.value)}/></label>
    <div><p>邀请成员</p>{agents.map(agent => <label className="invite-row" key={agent.id}><input type="checkbox" checked={selected.includes(agent.id)} onChange={() => setSelected(value => value.includes(agent.id) ? value.filter(id => id !== agent.id) : [...value, agent.id])}/><RobotAvatar id={agent.id} avatarId={agent.avatarId}/><span>{agent.name}<small>{agent.model} · {agent.effort}{!agent.machineId ? ' · 待配置设备' : ''}</small></span></label>)}</div>
    {fallback && <><p className="muted">部分旧 Agent 尚未配置设备，以下只作为这些成员的本次执行默认值；已配置成员仍使用自己的设备。</p><label>远端机器<select required disabled={!ready} value={machineId} onChange={event => { setMachineId(event.target.value); setDirectory(''); }}><option value="">{ready ? '选择机器' : '请先连接 Paws'}</option>{machines.map(machine => <option key={machine.id} value={machine.id}>{machineLabel(machine)}</option>)}</select></label><RemoteDirectoryPicker key={machineId} machineId={machineId} value={directory} onChange={setDirectory} api={api} disabled={!ready || busy}/></>}
    <label className="check-label"><input type="checkbox" checked={autoReply} onChange={event => setAutoReply(event.target.checked)}/>允许未 @ 时自动由一个相关成员接话</label>
    <label className="check-label"><input type="checkbox" checked={autoDebate} onChange={event => setAutoDebate(event.target.checked)}/>同时 @ 多位成员时自动辩论</label>
    {autoDebate && <label>最多轮数<select aria-label="新群聊最大辩论轮数" value={maxRounds} onChange={event => setMaxRounds(Number(event.target.value))}>{Array.from({ length: 10 }, (_, i) => <option key={i} value={i + 1}>{i + 1} 轮</option>)}</select></label>}
    <button className="primary-action" disabled={busy || !ready || !selected.length || !resolvedMachine || !resolvedDirectory?.startsWith('/')}>{busy ? '创建中…' : '创建群聊'}</button>{!ready && <p className="muted">请先从左下角连接 Paws。</p>}{error && <p role="alert">{error}</p>}
  </form></Modal>;
}
function Modal({ title, children, close }: { title: string; children: React.ReactNode; close(): void }) {
  const dialog = useDialogFocus(true, close);
  return <div className="workbench-modal-backdrop"><section ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="workbench-modal"><header className="workbench-modal-header"><h2>{title}</h2><button onClick={close}>关闭</button></header>{children}</section></div>;
}

function MemberDetails({ room, memberId, profiles, machines, api, close }: { room: GroupRoomSnapshot; memberId: string; profiles: AgentProfile[]; machines: MachinesResponse['machines']; api: ReturnType<typeof createApi>; close(): void }) {
  const member = room.members.find(item => item.id === memberId)!;
  const [page, setPage] = useState<AgentMessagesResponse | null>(null);
  const [error, setError] = useState('');
  const [records, setRecords] = useState<AgentMessagesResponse['messages']>([]);
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort(); const operation = new AbortController(); controller.current = operation; setBusy(true); setError('');
    try { const result = await api<AgentMessagesResponse>(`/api/group-chat/rooms/${room.id}/agents/${memberId}/messages?afterSeq=${cursor.current}`, { signal: operation.signal });
      if (operation.signal.aborted) return;
      setPage(result); setRecords(previous => [...new Map([...previous, ...result.messages].map(record => [record.id, record])).values()]);
      cursor.current = result.messages.reduce((value, record) => Math.max(value, record.seq), cursor.current);
    } catch (error) { if (!operation.signal.aborted) setError((error as Error).message); } finally { if (!operation.signal.aborted) setBusy(false); }
  }, [api, room.id, memberId]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load]);
  const executionMachineId = member.machineId ?? room.machineId;
  const executionMachine = machines.find(machine => machine.id === executionMachineId) ?? { id: executionMachineId, active: false } as MachinesResponse['machines'][number];
  return <Modal title={`${member.name} · 执行详情`} close={close}><div className="detail-profile"><RobotAvatar id={member.id} avatarId={displayAvatarId(member, profiles)} large/><div><h3>{member.name}</h3><p>{memberStatusLabel(member.status)}</p></div></div><p>{member.instructions}</p><dl className="configuration-summary"><dt>执行配置快照</dt><dd>{member.model} · {member.effort}</dd><dt>执行设备</dt><dd>{machineLabel(executionMachine)}</dd><dt>工作目录</dt><dd>{member.directory ?? room.directory}</dd></dl>{member.sessionId && <a href={`https://47.115.228.20:8443/session/${encodeURIComponent(member.sessionId)}`} target="_blank" rel="noreferrer">在 Paws 打开完整会话 ↗</a>}<p className="muted">以下是实际收到的执行记录，不保证包含隐藏推理。停止协调不等于终止远端进程。</p>{!!page?.requests.length && <p role="status">有待授权操作，请在 Paws 原始会话处理。</p>}{records.map(record => <details key={record.id}><summary>记录 #{record.seq}</summary><pre>{JSON.stringify(record.content, null, 2)}</pre></details>)}{error && <p role="alert">{error}</p>}<button disabled={busy} onClick={() => void load()}>{busy ? '读取中…' : page?.hasMore ? '加载更多' : '刷新记录'}</button></Modal>;
}

function InviteDialog({ room, agents, machines, sessions, api, refresh, close }: { room: GroupRoomSnapshot; agents: AgentProfile[]; machines: MachinesResponse['machines']; sessions: ConfigurationSession[]; api: ReturnType<typeof createApi>; refresh(): Promise<void>; close(): void }) {
  const [selected, setSelected] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [temporary, setTemporary] = useState(false); const requestId = useRef(crypto.randomUUID());
  const available = agents.filter(agent => !room.members.some(member => member.id === agent.id));
  const submit = async (data: object) => {
    await api(`/api/group-chat/rooms/${room.id}/members`, { method: 'POST', body: JSON.stringify({ requestId: requestId.current, ...data }) }); await refresh(); close();
  };
  return <Modal title="邀请成员" close={close}><div className="dialog-tabs"><button aria-pressed={!temporary} onClick={() => setTemporary(false)}>我的 Agent</button><button aria-pressed={temporary} onClick={() => setTemporary(true)}>临时成员</button></div><p className="muted">新成员可以阅读本群上下文；已开始的辩论仍由原参与者完成。</p>{temporary ? <><p>只加入本群，不保存到我的 Agent。</p><ProfileEditor machines={machines} sessions={sessions} api={api} submitLabel="创建并加入群聊" onSave={value => submit({ temporary: [value] })}/></> : <>{available.map(agent => <label className="invite-row" key={agent.id}><input type="checkbox" checked={selected.includes(agent.id)} onChange={() => setSelected(previous => previous.includes(agent.id) ? previous.filter(id => id !== agent.id) : [...previous, agent.id])}/><RobotAvatar id={agent.id} avatarId={agent.avatarId}/><span>{agent.name}<small>{agent.instructions}</small></span></label>)}{!available.length && <p>配置库中的 Agent 都已加入本群。</p>}<button className="primary-action" disabled={!selected.length || busy} onClick={async () => { setBusy(true); try { await submit({ memberIds: selected }); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }}>邀请已选成员</button></>}{error && <p role="alert">{error}</p>}</Modal>;
}
