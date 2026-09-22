import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { ImageRef, PartyEnvelope } from '../contracts.js';
import { MessageText } from '../../vendor/agents-party/src/ui/party/message.js';
import { validateImages, type Api } from './api.js';
import { useDialogFocus } from './modalFocus.js';

function ImageViewer({ src, name, close }: { src: string; name: string; close(): void }) {
  const dialog = useDialogFocus(true, close);
  return createPortal(<section ref={dialog} className="image-viewer" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} onClick={close}><button type="button" aria-label="关闭图片" onClick={close}>关闭</button><img src={src} alt={name} onClick={event => event.stopPropagation()}/></section>, document.body);
}

export function AssetImage({ image, api }: { image: ImageRef; api: Api }) {
  const [src, setSrc] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    setSrc(''); setError('');
    void api.blob(`/api/assets/${encodeURIComponent(image.id)}`, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setSrc(url);
    }).catch(() => { if (!controller.signal.aborted) setError('图片读取失败，请重连后再试。'); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [image.id, api]);
  return src ? <><button className="asset-image-trigger" type="button" aria-label={`打开图片 ${image.name}`} onClick={() => setExpanded(true)}><img src={src} alt={image.name} className="max-h-40 max-w-full rounded-md" /></button>{expanded && <ImageViewer src={src} name={image.name} close={() => setExpanded(false)}/>}</> : <span role={error ? 'alert' : 'status'}>{error || '图片加载中…'}</span>;
}

export function Attachments({ images, onChange, api, disabled = false, onBusy }: {
  images: ImageRef[]; onChange: (images: ImageRef[]) => void; api: Api; disabled?: boolean; onBusy?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const uploadRef = useRef<AbortController | null>(null);
  useEffect(() => () => { uploadRef.current?.abort(); }, []);
  return <div className="flex w-full flex-wrap items-center gap-2">
    <label className="rounded border border-border px-2 py-1">添加图片
      <input aria-label="添加图片" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled || busy}
        className="block max-w-52 text-xs" onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
          setError('');
          try { validateImages(files, images.length); } catch (error) { setError((error as Error).message); return; }
          const controller = new AbortController();
          uploadRef.current?.abort(); uploadRef.current = controller;
          const current = () => uploadRef.current === controller && !controller.signal.aborted;
          setBusy(true); onBusy?.(true);
          void Promise.all(files.map(file => api<ImageRef>('/api/assets', {
            method: 'POST', headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(file.name) }, body: file, signal: controller.signal,
          }))).then(uploaded => { if (current()) onChange([...images, ...uploaded]); })
            .catch(error => { if (current()) setError((error as Error).message); })
            .finally(() => { if (current()) { setBusy(false); onBusy?.(false); uploadRef.current = null; } });
        }} />
    </label>
    {busy && <span role="status">上传中…</span>}
    {images.map(image => <figure key={image.id} className="max-w-36 rounded border border-border p-1">
      <AssetImage image={image} api={api} /><figcaption className="break-all text-xs">{image.name}</figcaption>
      <button type="button" disabled={disabled || busy} aria-label={`移除 ${image.name}`} onClick={() => onChange(images.filter(item => item.id !== image.id))}>移除</button>
    </figure>)}
    {error && <span role="alert" className="text-destructive">{error}</span>}
  </div>;
}

export function decodeEnvelope(text: string | null): PartyEnvelope | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (value.v === 1 && typeof value.text === 'string' && Array.isArray(value.images)) return value as PartyEnvelope;
  } catch { /* Original Party plaintext is still displayable. */ }
  return null;
}

export function RichMessage({ text, api }: { text: string | null; api: Api }) {
  const envelope = decodeEnvelope(text);
  return <><MessageText text={envelope?.text ?? text} />
    {envelope?.images.map(image => <AssetImage key={image.id} image={image} api={api} />)}</>;
}
