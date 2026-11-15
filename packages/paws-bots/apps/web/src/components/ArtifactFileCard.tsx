import { i18n } from "@lingui/core";
import { t as translate } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { artifactPreviewKind, isAttachmentAudioMimeType } from "@rakazo/contracts";
import { fileSizeParts } from "@rakazo/core";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle, Spinner } from "@rakazo/ui-web";
import { Code2, Download, FileText, Play, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import { downloadArtifact, downloadArtifactBytes, fetchArtifactBytes } from "../lib/artifact-open";
import { errorText } from "../lib/user-error";
import { BuiCard } from "./ai/primitives";
import { IconTooltip } from "./IconTooltip";
import { PdfViewer } from "./PdfViewer";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

type ArtifactFileCardProps = {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
};

function isTextPreview(mimeType: string) {
  const kind = artifactPreviewKind(mimeType);
  return kind === "markdown" || kind === "html" || kind === "text";
}

function isPreviewable(mimeType: string) {
  return (
    isTextPreview(mimeType) ||
    artifactPreviewKind(mimeType) === "pdf" ||
    artifactPreviewKind(mimeType) === "video"
  );
}

export function ArtifactFileCard(props: ArtifactFileCardProps) {
  const { t } = useLingui();
  const previewable = isPreviewable(props.mimeType);
  const previewButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function startDownload() {
    setDownloadError(null);
    try {
      await downloadArtifact(props.target, props.artifactId, props.name, props.mimeType);
    } catch {
      setDownloadError(t`Could not download ${props.name}. Try again.`);
    }
  }

  if (isAttachmentAudioMimeType(props.mimeType)) {
    return (
      <BuiCard className="min-w-[280px] p-4 text-foreground">
        <AudioArtifactPreview
          key={JSON.stringify([props.target, props.artifactId, props.mimeType])}
          {...props}
          onDownload={startDownload}
        />
        {downloadError ? <DownloadError message={downloadError} /> : null}
      </BuiCard>
    );
  }

  if (!previewable) {
    return (
      <div>
        <button
          type="button"
          onClick={() => void startDownload()}
          className="rounded-2xl bg-card px-4 py-3 text-left text-body text-foreground hover:bg-accent"
        >
          <div className="font-medium">{props.name}</div>
          <div className="mt-1 flex gap-2 text-muted-foreground">
            <span>{props.mimeType}</span>
            <span>{formatSize(props.size)}</span>
          </div>
        </button>
        {downloadError ? <DownloadError message={downloadError} /> : null}
      </div>
    );
  }

  return (
    <>
      <div>
        <BuiCard className="flex min-w-[280px] overflow-hidden text-left text-foreground">
          <button
            ref={previewButton}
            type="button"
            aria-label={t`Preview ${props.name}`}
            onClick={() => setPreviewOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-accent"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-muted text-foreground">
              {props.mimeType === "text/html" ? (
                <Code2 size={21} strokeWidth={1.8} />
              ) : (
                <FileText size={21} strokeWidth={1.8} />
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-body font-medium">{props.name}</span>
              <span className="mt-0.5 block text-body-sm text-muted-foreground">
                {formatSize(props.size)}
              </span>
            </span>
          </button>
          <IconTooltip label={t`Download ${props.name}`}>
            <button
              type="button"
              aria-label={t`Download ${props.name}`}
              onClick={() => void startDownload()}
              className="grid w-14 shrink-0 place-items-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Download size={19} strokeWidth={1.8} />
            </button>
          </IconTooltip>
        </BuiCard>
        {downloadError ? <DownloadError message={downloadError} /> : null}
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton={false}
          initialFocus={closeButton}
          finalFocus={previewButton}
          className="flex h-[min(88vh,900px)] w-[min(960px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <FilePreview {...props} closeButtonRef={closeButton} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function FilePreview({
  target,
  artifactId,
  name,
  mimeType,
  closeButtonRef,
}: ArtifactFileCardProps & { closeButtonRef: RefObject<HTMLButtonElement | null> }) {
  const { t } = useLingui();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; bytes: Uint8Array; text?: string }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    let cancelled = false;
    const artifactTarget: ArtifactTarget =
      targetBotId !== undefined ? { botId: targetBotId } : { groupId: targetGroupId! };
    void fetchArtifactBytes(artifactTarget, artifactId)
      .then((bytes) => {
        if (cancelled) return;
        if (!isTextPreview(mimeType)) {
          setState({ status: "ready", bytes });
          return;
        }
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          setState({ status: "ready", bytes, text });
        } catch {
          setState({ status: "error", message: t`This file is not valid UTF-8 text.` });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: errorText(error, t`Could not load this file.`),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, targetBotId, targetGroupId, mimeType, t]);
  const kind = artifactPreviewKind(mimeType);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-5">
        <DialogTitle className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
          {name}
        </DialogTitle>
        <IconTooltip label={t`Download ${name}`}>
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-full text-muted-foreground"
            aria-label={t`Download ${name}`}
            onClick={() =>
              void (async () => {
                setDownloadError(null);
                try {
                  if (state.status === "ready") downloadArtifactBytes(name, mimeType, state.bytes);
                  else await downloadArtifact(target, artifactId, name, mimeType);
                } catch {
                  setDownloadError(t`Could not download ${name}. Try again.`);
                }
              })()
            }
          >
            <Download />
          </Button>
        </IconTooltip>
        <DialogClose
          ref={closeButtonRef}
          aria-label={t`Close preview`}
          render={
            <Button variant="ghost" size="icon-lg" className="rounded-full text-muted-foreground" />
          }
        >
          <X />
        </DialogClose>
      </header>
      {downloadError ? (
        <div className="shrink-0 px-5 pt-4">
          <DownloadError message={downloadError} />
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" ? (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <Spinner aria-label={t`Loading preview…`} />
          </div>
        ) : state.status === "error" ? (
          <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
            {state.message}
          </div>
        ) : kind === "html" && state.text !== undefined ? (
          <SandboxedHtmlViewer html={state.text} title={name} />
        ) : kind === "video" ? (
          <VideoPreview bytes={state.bytes} name={name} />
        ) : kind === "pdf" ? (
          <PdfViewer bytes={state.bytes} title={name} />
        ) : state.text !== undefined && kind === "text" ? (
          <pre className="px-8 py-10 font-mono text-body-sm leading-6 whitespace-pre-wrap break-words text-foreground sm:px-12 sm:py-12">
            {state.text}
          </pre>
        ) : state.text !== undefined ? (
          <article className="mx-auto w-full max-w-[760px] px-8 py-10 text-body-lg leading-7 text-foreground sm:px-12 sm:py-12">
            <ChatMarkdown>{state.text}</ChatMarkdown>
          </article>
        ) : null}
      </div>
    </>
  );
}

function AudioArtifactPreview({
  target,
  artifactId,
  name,
  mimeType,
  onDownload,
}: ArtifactFileCardProps & { onDownload: () => Promise<void> }) {
  const { t } = useLingui();
  const [state, setState] = useState<
    { status: "idle" | "loading" } | { status: "ready"; src: string } | { status: "error" }
  >({ status: "idle" });
  const lifetime = useRef<{ cancelled: boolean; started: boolean; url?: string }>(null);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const current = { cancelled: false, started: false, url: undefined as string | undefined };
    lifetime.current = current;
    return () => {
      current.cancelled = true;
      if (current.url) URL.revokeObjectURL(current.url);
    };
  }, []);
  useEffect(() => {
    if (state.status !== "ready") return;
    const player = audio.current;
    void player?.play().catch(() => {});
    return () => player?.pause();
  }, [state]);

  async function startPlayback() {
    const current = lifetime.current;
    if (!current || current.cancelled || current.started) return;
    current.started = true;
    setState({ status: "loading" });
    try {
      const bytes = await fetchArtifactBytes(target, artifactId);
      if (current.cancelled) return;
      if (!isAttachmentAudioMimeType(mimeType)) throw new Error("Unsupported audio type");
      current.url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
      setState({ status: "ready", src: current.url });
    } catch {
      if (!current.cancelled) setState({ status: "error" });
    }
  }

  return (
    <>
      <div className="flex items-center gap-3">
        {state.status === "idle" || state.status === "loading" ? (
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={t`Play ${name}`}
            aria-busy={state.status === "loading"}
            disabled={state.status === "loading"}
            onClick={() => void startPlayback()}
          >
            <Play />
          </Button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-body font-medium">{name}</span>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={t`Download ${name}`}
          onClick={() => void onDownload()}
          className="text-muted-foreground"
        >
          <Download strokeWidth={1.8} className="size-[19px]" />
        </Button>
      </div>
      {state.status === "loading" ? (
        <span className="text-body text-muted-foreground">
          <Spinner aria-label={t`Loading preview…`} />
        </span>
      ) : state.status === "error" ? (
        <DownloadError message={t`Could not load this file.`} />
      ) : state.status === "ready" ? (
        // biome-ignore lint/a11y/useMediaCaption: Attachment playback has no caption track supplied by the author.
        <audio
          ref={audio}
          src={state.src}
          controls
          preload="metadata"
          aria-label={name}
          className="mt-3 w-full"
        />
      ) : null}
    </>
  );
}

export function VideoPreview({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/mp4" }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [bytes]);
  return (
    // biome-ignore lint/a11y/useMediaCaption: Attachment playback has no caption track supplied by the author.
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      aria-label={name}
      className="h-full w-full object-contain"
    />
  );
}

function DownloadError({ message }: { message: string }) {
  return (
    <div role="alert" className="mt-2 text-left text-body-sm text-destructive">
      {message}
    </div>
  );
}

function formatSize(bytes: number): string {
  const parts = fileSizeParts(bytes, i18n.locale || "en");
  if (!parts) return "";
  const size = parts.amount;
  switch (parts.unit) {
    case "B":
      return translate`${size} B`;
    case "KB":
      return translate`${parts.amount} KB`;
    case "MB":
      return translate`${parts.amount} MB`;
    case "GB":
      return translate`${parts.amount} GB`;
    case "TB":
      return translate`${parts.amount} TB`;
  }
}
