import { listenWindow } from "../../paws/runtime";
import { useLingui } from "@lingui/react/macro";
import type { ReplyPreview, ThreadMessage } from "@rakazo/contracts";
import {
  formatTimeSeparator,
  isPageOriginReply,
  isPeerReceiptBlocks,
  replyLabel,
} from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useArtifactImage } from "../../lib/use-artifact-image";

function ReplyThumbnail({
  attachment,
  target,
  lazy = false,
}: {
  lazy?: boolean;
  attachment: NonNullable<ReplyPreview["attachment"]>;
  target: ArtifactTarget;
}) {
  const [visible, setVisible] = useState(!lazy);
  const container = useRef<HTMLSpanElement>(null);
  const src = useArtifactImage(target, attachment.artifactId, visible);
  useEffect(() => {
    if (!lazy) return;
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazy]);
  return (
    <span
      ref={container}
      aria-hidden="true"
      className="size-8 shrink-0 overflow-hidden rounded-md bg-muted"
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
    </span>
  );
}

export function TimeSeparator({ createdAt, locale }: { createdAt: string; locale: string }) {
  const { t } = useLingui();
  return (
    <h3
      data-testid="time-separator"
      className="mt-5 select-none text-center text-label font-normal text-muted-foreground"
    >
      {formatTimeSeparator(createdAt, locale, { today: t`Today`, yesterday: t`Yesterday` })}
    </h3>
  );
}

/** Marks where the messages the user hadn't seen yet begin. */
export function UnreadDivider({ afterSeparator = false }: { afterSeparator?: boolean }) {
  const { t } = useLingui();
  return (
    <div
      data-testid="unread-divider"
      className={`flex select-none items-center gap-2.5 pb-2 ${afterSeparator ? "pt-0" : "pt-3.5"}`}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-unread opacity-50" />
      <span className="text-label font-semibold uppercase tracking-[0.5px] text-unread">
        <span aria-hidden="true">{t`New`}</span>
        <span className="sr-only">{t`New messages`}</span>
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-unread opacity-50" />
    </div>
  );
}

export function ComposerReplyPreview({
  author,
  text,
  quote,
  attachment,
  target,
  onDismiss,
}: {
  author: string;
  text: string;
  quote?: string | null;
  attachment?: ReplyPreview["attachment"];
  target?: ArtifactTarget;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        onDismiss();
      }
    };
    listenWindow("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);
  return (
    <div
      data-testid="reply-chip"
      className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-muted px-3 py-1.5 text-body-sm"
    >
      {attachment?.kind === "image" && target ? (
        <ReplyThumbnail attachment={attachment} target={target} />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="auto">
        <span className="font-medium">{author}</span>:{" "}
        {replyLabel(quote, text, attachment, { photo: t`Photo`, attachment: t`Attachment` })}
      </span>
      <button
        type="button"
        aria-label={t`Cancel reply`}
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

export function ReplyLine({
  message,
  fallbackText,
  target,
  author,
  onJump,
}: {
  message: ThreadMessage;
  fallbackText?: string;
  target?: ArtifactTarget;
  author: string;
  onJump?: (id: string) => void;
}) {
  const { t } = useLingui();
  // Peer receipts use internal reply links for routing; their bodies belong in the peer view.
  if (isPeerReceiptBlocks(message.blocks) || isPageOriginReply(message)) return null;
  if (!message.replyToMessageId && message.replyQuote == null) return null;
  const unavailable = message.replyPreview === null || !message.replyToMessageId;
  if (unavailable)
    return (
      <div
        data-testid="reply-parent-preview"
        className={cn(
          "mb-1 truncate text-label text-muted-foreground",
          message.role === "user" && "text-end",
        )}
      >{t`Original message unavailable`}</div>
    );
  const attachment = message.replyPreview?.attachment;
  const text = replyLabel(
    message.replyQuote,
    message.replyPreview?.text || (attachment ? undefined : fallbackText),
    attachment,
    { photo: t`Photo`, attachment: t`Attachment` },
  );
  const excerpt = text.replace(/\s+/gu, " ").slice(0, 120);
  // The wrapper aligns in the frame's direction; the quote keeps its own text direction.
  return (
    <div className={cn("flex", message.role === "user" && "justify-end")}>
      <button
        type="button"
        data-testid="reply-parent-preview"
        aria-label={t`Jump to replied message: ${excerpt}`}
        onClick={() => {
          if (message.replyToMessageId) onJump?.(message.replyToMessageId);
        }}
        className="mb-1 flex min-w-0 max-w-full items-center gap-1 text-start text-label text-muted-foreground hover:text-foreground"
        dir="auto"
      >
        <span aria-hidden="true">↩ </span>
        {attachment?.kind === "image" && target ? (
          <ReplyThumbnail attachment={attachment} target={target} lazy />
        ) : null}
        <span className="min-w-0 truncate">
          {author}: {text}
        </span>
      </button>
    </div>
  );
}
