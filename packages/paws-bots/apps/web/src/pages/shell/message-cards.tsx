import { listenWindow } from "../../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import { useLinkPrompt } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import { appConnectedInput, waitForConnection } from "@rakazo/core";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BuiCard, SuccessPop } from "../../components/ai/primitives";
import { ErrorNotice } from "../../components/ErrorNotice";
import { OptionRow } from "../../components/OptionRow";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { chartViewport } from "../../lib/chart-viewport";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { importChunk } from "../../lib/preload-recovery";
import { rpc } from "../../lib/rpc";
import { useArtifactImage } from "../../lib/use-artifact-image";
import type { ErrorDetails } from "../../lib/user-error";
import { errorDetails, errorText } from "../../lib/user-error";

export function ChoiceCard({
  botId,
  block,
  onBotChanged,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
  onBotChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const dismissed = locallyDismissed || block.answerId === "_dismissed";

  async function choose(optionId: string) {
    setPending(true);
    setError(null);
    try {
      await rpc.onboarding.choose({ botId, optionId });
      await onBotChanged();
    } catch (err) {
      setError(errorText(err, t`Could not save this choice`));
      setPending(false);
    }
  }

  async function dismiss() {
    setPending(true);
    setError(null);
    try {
      await rpc.onboarding.dismissFocus({ botId });
      setLocallyDismissed(true);
      void onBotChanged().catch(() => undefined);
    } catch (err) {
      setError(errorText(err, t`Could not dismiss`));
      setPending(false);
    }
  }

  if (dismissed) return null;

  return (
    <div className="flex justify-start">
      <BuiCard className="relative w-[420px] max-w-full px-[18px] py-[14px]">
        {!block.answerId ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Dismiss`}
            disabled={pending}
            onClick={() => void dismiss()}
            className="absolute end-2 top-2 text-muted-foreground"
          >
            <X size={16} strokeWidth={1.8} />
          </Button>
        ) : null}
        <div className="pe-8 text-body-lg text-foreground/90">
          <OnboardingFocusQuestion question={block.question} />
        </div>
        {block.subtitle ? (
          <div className="mt-0.5 text-body-sm text-foreground/75">{block.subtitle}</div>
        ) : null}
        <div className="mt-2.5 space-y-0.5">
          {block.options.map((option) => (
            <OptionRow
              key={option.id}
              letter={option.letter}
              selected={block.answerId === option.id}
              disabled={Boolean(block.answerId) || pending}
              onClick={() => void choose(option.id)}
            >
              <OnboardingFocusOptionLabel
                id={option.id}
                label={option.label}
                question={block.question}
              />
            </OptionRow>
          ))}
        </div>
        {error ? <p className="mt-2 text-label text-destructive">{error}</p> : null}
      </BuiCard>
    </div>
  );
}

const FOCUS_QUESTION = "What do you want me on first?";

/** First-run Chief focus card: API stores English; UI locale catalogs translate it. */
function OnboardingFocusQuestion({ question }: { question: string }) {
  if (question === FOCUS_QUESTION) {
    return <Trans>What do you want me on first?</Trans>;
  }
  return question;
}

function OnboardingFocusOptionLabel({
  id,
  label,
  question,
}: {
  id: string;
  label: string;
  question: string;
}) {
  if (question !== FOCUS_QUESTION) return label;
  switch (id) {
    case "day":
      return <Trans>Day-to-day work</Trans>;
    case "inbox":
      return <Trans>Inbox & email</Trans>;
    case "research":
      return <Trans>Research & writing</Trans>;
    case "everything":
      return <Trans>A bit of everything</Trans>;
    default:
      return label;
  }
}

export function AppConnectCard({
  botId,
  threadId,
  messageId,
  block,
}: {
  botId: string;
  threadId: string;
  messageId?: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const status = block.status === "connected" ? "connected" : localStatus;
  useEffect(() => () => connectionAttempt.current?.abort(), []);

  async function authorize() {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.connections.begin({
        connectorId: block.connectorId,
        provider: block.provider,
        displayName: block.name,
      });
      if (started.authorizationUrl) {
        window.open(started.authorizationUrl, "rakazo-app-connect", "popup,width=560,height=720");
      }
      const result = await waitForConnection(
        started.connectionId,
        (input) => rpc.connections.complete(input, { signal: controller.signal }),
        { signal: controller.signal, attempts: 60 },
      );
      if (result.status === "aborted") return;
      if (result.status === "connected") {
        setLocalStatus("connected");
        await rpc.onboarding
          .appConnected(appConnectedInput(botId, threadId, block, messageId))
          .catch(() => undefined);
        return;
      }
      setError(t`Authorization timed out. Please try again.`);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(errorText(error, t`Could not authorize this app`));
      }
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <BuiCard
      role="group"
      aria-label={t`${block.name} connection`}
      className="w-full max-w-[440px] px-4 py-3.5"
    >
      <div className="flex items-center gap-3.5">
        {block.logo ? (
          <img
            src={block.logo}
            alt=""
            className="h-10 w-10 rounded-md bg-favicon-plate object-contain p-1"
          />
        ) : (
          <span className="grid h-10 w-10 place-items-center rounded-md bg-muted text-body-lg text-foreground">
            {block.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-body-lg font-medium text-foreground">{block.name}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            {block.description}
          </span>
        </span>
        {status === "connected" ? (
          <SuccessPop label={t`Connected`} />
        ) : (
          <Button disabled={busy} onClick={() => void authorize()}>
            {busy ? t`Waiting…` : t`Connect`}
          </Button>
        )}
      </div>
      {error ? <p className="mt-2 text-label text-destructive">{error}</p> : null}
    </BuiCard>
  );
}

function ChartCanvas({
  spec,
  data,
  width,
  height,
}: {
  spec: Record<string, unknown>;
  data: unknown[];
  width: number;
  height?: number;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const linkDialog = useLinkPrompt(ref);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    title?: string;
    swatches: { label: string; color: string }[];
  }>({ swatches: [] });
  useEffect(() => {
    let cancelled = false;
    // Plot loads lazily so threads without charts never pay for the library.
    void (async () => {
      try {
        const { buildPlotParts } = await importChunk(() => import("@rakazo/core/plot"));
        if (cancelled || !ref.current) return;
        // Hover inspection by default: give the first mark a tooltip unless
        // the spec already asks for one somewhere.
        const marks = Array.isArray((spec as { marks?: unknown[] }).marks)
          ? ((spec as { marks: { options?: Record<string, unknown> }[] }).marks ?? [])
          : [];
        const hasTip = marks.some((mark) => mark.options && "tip" in mark.options);
        const liveSpec = hasTip
          ? spec
          : {
              ...spec,
              marks: marks.map((mark, index) =>
                index === 0 ? { ...mark, options: { ...(mark.options ?? {}), tip: true } } : mark,
              ),
            };
        const parts = buildPlotParts(liveSpec as never, data, document, { width, height });
        setMeta({ title: parts.title, swatches: parts.swatches });
        setError(null);
        ref.current.replaceChildren(parts.plotted);
      } catch (err) {
        if (!cancelled) setError(errorText(err, t`Could not render chart`));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec, data, width, height, t]);
  if (error)
    return (
      <div className="text-body-sm text-destructive">
        <Trans>Chart failed to render: {error}</Trans>
      </div>
    );
  return (
    <div className="text-foreground/75">
      {meta.title ? (
        <div className="mb-1 text-body-lg font-semibold text-foreground">{meta.title}</div>
      ) : null}
      {meta.swatches.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
          {meta.swatches.map((swatch) => (
            <span
              key={swatch.label}
              className="flex items-center gap-1.5 text-label text-muted-foreground"
            >
              {/* Series colours are data-driven and intentionally distinct. */}
              <span
                className="h-[10px] w-[10px] rounded-[3px]"
                style={{ background: swatch.color }}
              />
              {swatch.label}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={ref} className="overflow-hidden [contain:paint] [&_svg]:max-w-full" />
      {linkDialog}
    </div>
  );
}

type McpApprovalState = "pending" | "connecting" | "connected" | "dismissed";

/** Approval card for an agent-created MCP server: the user completes browser
 * OAuth (or confirms no authorization is needed) without leaving the chat.
 * The decision persists on the block, so the card keeps showing it after the
 * thread remounts. */
export function McpApprovalCard({
  botId,
  threadId,
  block,
}: {
  botId: string | undefined;
  threadId: string | undefined;
  block: Extract<MessageBlock, { kind: "mcp_approval" }>;
}) {
  const { t } = useLingui();
  const { name, serverId, transport, endpoint, needsOAuth, status: savedStatus } = block;
  const [localStatus, setLocalStatus] = useState<McpApprovalState>("pending");
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [busy, setBusy] = useState(false);
  // A removal repaints the block to pending. Drop an in-session connected
  // override so the card does not keep the old decision.
  useEffect(() => {
    if (savedStatus === "connected" || savedStatus === "dismissed") return;
    setLocalStatus((current) =>
      current === "connected" || current === "dismissed" ? "pending" : current,
    );
  }, [savedStatus]);
  // Blocks saved before the status field existed have none and count as pending.
  const state =
    savedStatus === "connected" || savedStatus === "dismissed" ? savedStatus : localStatus;

  async function authorize() {
    if (!botId || busy) {
      if (!botId) setError(errorDetails(t`This server cannot be assigned without a bot.`));
      return;
    }
    setBusy(true);
    setLocalStatus("connecting");
    setError(null);
    try {
      if (needsOAuth) {
        const result = await connectMcpOauth(serverId);
        if (result === "cancelled") {
          setLocalStatus("pending");
          return;
        }
      }
      await rpc.mcp.assignments.approve({ botId, serverId, threadId });
      setLocalStatus("connected");
    } catch (err) {
      setError(errorDetails(err, t`Could not approve this server`));
      setLocalStatus("pending");
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (botId) {
        await rpc.mcp.assignments.dismiss({ botId, serverId, threadId });
      }
      setLocalStatus("dismissed");
    } catch (err) {
      setLocalStatus("pending");
      setError(errorDetails(err, t`Could not dismiss this server`));
    } finally {
      setBusy(false);
    }
  }

  const summary = endpoint ?? `stdio (${transport})`;
  return (
    <BuiCard data-testid="mcp-approval-card" className="w-full min-w-0 max-w-xl p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-muted text-label text-foreground">
          M
        </span>
        <span className="text-body-lg font-medium text-foreground">
          <Trans>Connect MCP server “{name}”</Trans>
        </span>
      </div>
      <p className="mt-1.5 truncate text-label text-muted-foreground">{summary}</p>
      {state === "pending" || state === "connecting" ? (
        <>
          <p className="mt-2 text-body-sm leading-[1.5] text-foreground/75">
            {needsOAuth
              ? t`Authorize this server so agents can use its tools. A popup opens.`
              : t`Approve this server to let your agent use its tools.`}
          </p>
          {error ? (
            <div className="mt-2">
              <ErrorNotice error={error} />
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={state !== "pending" || busy} onClick={() => void authorize()}>
              {state === "connecting" ? t`Connecting…` : needsOAuth ? t`Authorize` : t`Approve`}
            </Button>
            <Button
              variant="secondary"
              disabled={state !== "pending" || busy}
              onClick={() => void dismiss()}
            >
              <Trans>Not now</Trans>
            </Button>
          </div>
        </>
      ) : null}
      {state === "connected" ? (
        <div className="mt-3">
          <SuccessPop label={t`Connected`} />
        </div>
      ) : null}
      {state === "dismissed" ? (
        <p className="mt-2 text-body-sm text-muted-foreground">
          <Trans>Dismissed. Reconnect anytime from MCP settings.</Trans>
        </p>
      ) : null}
    </BuiCard>
  );
}

export function ChartBlockView({
  name,
  spec,
  data,
}: {
  name: string;
  spec: Record<string, unknown>;
  data: unknown[];
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    if (!expanded) return;
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    listenWindow("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [expanded]);
  const expandedViewport = chartViewport(viewport.width, viewport.height);
  return (
    <>
      <div className="group relative w-[552px] max-w-full rounded-2xl bg-muted p-4">
        <ChartCanvas spec={spec} data={data} width={520} />
        <Button
          variant="outline"
          size="xs"
          onClick={() => setExpanded(true)}
          className="absolute end-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trans>Expand</Trans>
        </Button>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[92vh] w-[min(1320px,94vw)] max-w-none overflow-auto p-8 sm:max-w-none"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-body-sm font-normal text-muted-foreground">
              {name}
            </DialogTitle>
            <DialogClose
              aria-label={t`Close chart`}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <X />
            </DialogClose>
          </div>
          <ChartCanvas
            spec={spec}
            data={data}
            width={expandedViewport.width}
            height={expandedViewport.height}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ArtifactImage({
  target,
  artifactId,
  name,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const src = useArtifactImage(target, artifactId, visible);

  useEffect(() => {
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
  }, []);

  return (
    <div ref={container}>
      {src ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="max-w-[240px] overflow-hidden rounded-2xl"
        >
          <img src={src} alt={name} className="max-h-48 w-full object-cover" />
        </button>
      ) : (
        <div className="rounded-2xl bg-muted px-4 py-3 text-body text-muted-foreground">{name}</div>
      )}
      {src ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            showCloseButton={false}
            className="w-auto max-w-none bg-transparent p-0 ring-0 sm:max-w-none"
          >
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <DialogClose
              aria-label={t`Close image preview`}
              render={<Button variant="ghost" size="icon-sm" className="absolute end-2 top-2" />}
            >
              <X />
            </DialogClose>
            <img
              src={src}
              alt={name}
              className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain"
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
