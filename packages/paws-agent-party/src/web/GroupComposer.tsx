import { AtSign, ImagePlus, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ImageRef } from '../contracts.js';
import type { GroupRoomSnapshot } from '../group-chat/rooms.js';
import type { AgentProfile } from '../group-chat/profiles.js';
import { AssetImage } from './Attachments.js';
import { validateImages, type Api } from './api.js';
import { RobotAvatar } from './RobotAvatar.js';
import { displayAvatarId } from './display-avatar.js';

export type ComposerDraft = { text: string; images: ImageRef[] };
export function GroupComposer({ room, profiles, draft, change, api, send, sending, mentionRequest }: {
  room: GroupRoomSnapshot; profiles?: AgentProfile[]; draft: ComposerDraft; change(value: ComposerDraft): void; api: Api;
  send(): void; sending: boolean; mentionRequest: number;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const upload = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const matches = room.members.filter(member => !mention?.query || member.name.toLowerCase().includes(mention.query.toLowerCase()));
  const currentDraft = useRef(draft); currentDraft.current = draft;
  const onChange = useRef(change); onChange.current = change;
  useEffect(() => () => upload.current?.abort(), []);
  const detectMention = (text: string, end: number) => {
    const match = /(?:^|\s)@([^@\s]*)$/.exec(text.slice(0, end));
    setMention(match ? { start: end - match[1].length - 1, end, query: match[1] } : null); setActive(0);
  };
  const openMention = () => {
    const element = input.current; const text = currentDraft.current.text;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? start;
    const prefix = start && !/\s/.test(text[start - 1]) ? ' @' : '@';
    const next = text.slice(0, start) + prefix + text.slice(end);
    change({ ...draft, text: next }); detectMention(next, start + prefix.length);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + prefix.length, start + prefix.length); });
  };
  useEffect(() => { if (mentionRequest > 0) openMention(); }, [mentionRequest]);
  const select = (name: string) => {
    if (!mention) return;
    const text = draft.text.slice(0, mention.start) + `@${name} ` + draft.text.slice(mention.end);
    const caret = mention.start + name.length + 2;
    change({ ...draft, text }); setMention(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(caret, caret); });
  };
  const uploadFiles = async (files: File[]) => {
    if (busy || sending || !files.length) return;
    setError('');
    try { validateImages(files, currentDraft.current.images.length); } catch (error) { setError((error as Error).message); return; }
    const controller = new AbortController(); upload.current = controller; setBusy(true);
    try {
      const images = await Promise.all(files.map(file => api<ImageRef>('/api/assets', { method: 'POST', headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(file.name) }, body: file, signal: controller.signal })));
      if (!controller.signal.aborted) onChange.current({ ...currentDraft.current, images: [...currentDraft.current.images, ...images] });
    } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <div className="composer-inner">
    {mention && <div className="mention-menu" role="listbox" id="mention-members" aria-label="选择提及的成员"><small>本群成员 · ↑ ↓ 选择，Enter 插入</small>{matches.map((member, index) => <button type="button" role="option" id={`mention-${member.id}`} aria-selected={active === index} key={member.id} onMouseDown={event => event.preventDefault()} onClick={() => select(member.name)}><RobotAvatar id={member.id} avatarId={displayAvatarId(member, profiles ?? [])}/><span><strong>{member.name}</strong><small>{member.instructions}</small></span></button>)}{!matches.length && <p>没有匹配成员，可从「成员」邀请。</p>}</div>}
    <div className="composer-box"><textarea ref={input} aria-label="群聊消息" aria-controls={mention ? 'mention-members' : undefined} aria-activedescendant={mention && matches[active] ? `mention-${matches[active].id}` : undefined} value={draft.text}
      onChange={event => { change({ ...draft, text: event.target.value }); detectMention(event.target.value, event.target.selectionStart); }}
      onClick={event => detectMention(draft.text, event.currentTarget.selectionStart)}
      onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void uploadFiles(files); } }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (mention && event.key === 'Escape') { event.preventDefault(); setMention(null); return; }
        if (mention && matches.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length); return; }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (mention) { if (matches[active]) select(matches[active].name); } else if (!busy && !sending) send(); }
      }} placeholder="说点什么，或输入 @ 邀请一位、几位成员回答…"/>
      {!!draft.images.length && <div className="composer-images">{draft.images.map(image => <figure key={image.id}><AssetImage image={image} api={api}/><button type="button" disabled={busy || sending} aria-label={`移除 ${image.name}`} onClick={() => change({ ...draft, images: draft.images.filter(item => item.id !== image.id) })}><X size={14}/></button></figure>)}</div>}
      <div className="composer-tools"><button type="button" className="mention-trigger" aria-label="提及成员" aria-expanded={!!mention} onClick={openMention}><AtSign size={19}/></button><label className="image-upload"><ImagePlus size={19}/><span>图片 + 文字</span><input type="file" aria-label="添加图片" accept="image/png,image/jpeg,image/webp" multiple disabled={busy || sending} onChange={event => { void uploadFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }}/></label>{busy && <span role="status">上传中…</span>}<button type="button" className="send-button" aria-label="发送消息" disabled={busy || sending || (!draft.text.trim() && !draft.images.length)} onClick={send}>{sending ? '发送中' : '发送'}<Send size={15}/></button></div>
    </div><div className="composer-hint"><span>直接聊天，或 @ 多位成员</span><span>Enter 发送 · Shift + Enter 换行</span></div>{error && <p role="alert">{error}</p>}
  </div>;
}
