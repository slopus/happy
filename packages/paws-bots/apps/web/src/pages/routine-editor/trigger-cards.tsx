import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine, RoutineEmailSenders } from "@rakazo/contracts";
import { ROUTINE_WATCH_MIN_MINUTES } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
} from "@rakazo/ui-web";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  Mail,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";
import { BotEmailAddressField } from "../../components/BotEmailAddressField";
import { InfoTooltip } from "../../components/InfoTooltip";
import { authClient } from "../../lib/auth";
import { useCopyText } from "../../lib/copy-text";
import type { RoutineWatchDraft } from "../../lib/routine-draft";

export function WatchTriggerCard({
  watch,
  state,
  onChange,
  onRemove,
}: {
  watch: RoutineWatchDraft;
  state: Routine["watchState"];
  onChange: (watch: RoutineWatchDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const status = !state
    ? null
    : state.outcome === "failed"
      ? t`Check failed: ${state.detail ?? ""}`
      : state.outcome === "changed"
        ? t`Last check ${new Date(state.checkedAt).toLocaleString()}: changed`
        : t`Last check ${new Date(state.checkedAt).toLocaleString()}: no changes`;
  return (
    <div className="rounded-xl border border-border p-3" data-testid="routine-watch-card">
      <div className="flex items-center gap-2.5 px-0.5">
        <Eye size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">
          <Trans>When something changes</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove change trigger`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <div className="mt-3 space-y-3">
        <NativeSelect
          className="w-full"
          aria-label={t`What to watch`}
          value={watch.kind}
          onChange={(event) =>
            onChange({ ...watch, kind: event.target.value as RoutineWatchDraft["kind"] })
          }
        >
          <NativeSelectOption value="files">{t`Files or folders on the computer`}</NativeSelectOption>
          <NativeSelectOption value="http">{t`An HTTPS endpoint`}</NativeSelectOption>
          <NativeSelectOption value="command">{t`A command's output`}</NativeSelectOption>
          <NativeSelectOption value="tool">{t`An integration tool`}</NativeSelectOption>
        </NativeSelect>
        {watch.kind === "files" ? (
          <Textarea
            aria-label={t`Files or folders, one per line`}
            placeholder="reports/latest.csv"
            value={watch.paths}
            onChange={(e) => onChange({ ...watch, paths: e.target.value })}
            className="min-h-0"
          />
        ) : null}
        {watch.kind === "command" ? (
          <Input
            aria-label={t`Command`}
            placeholder="cat reports/status.json"
            value={watch.command}
            onChange={(e) => onChange({ ...watch, command: e.target.value })}
            className="font-mono text-body-sm"
          />
        ) : null}
        {watch.kind === "http" ? (
          <Input
            aria-label={t`HTTPS URL`}
            type="url"
            placeholder="https://example.com/status"
            value={watch.url}
            onChange={(e) => onChange({ ...watch, url: e.target.value })}
            className="font-mono text-body-sm"
          />
        ) : null}
        {watch.kind === "tool" ? (
          <>
            <Input
              aria-label={t`Tool name`}
              placeholder="brain_changed"
              value={watch.tool}
              onChange={(e) => onChange({ ...watch, tool: e.target.value })}
              className="font-mono text-body-sm"
            />
            <Textarea
              aria-label={t`Tool arguments (JSON)`}
              value={watch.args}
              onChange={(e) => onChange({ ...watch, args: e.target.value })}
              rows={2}
              className="font-mono text-body-sm"
            />
          </>
        ) : null}
        <label
          htmlFor={`${id}-every`}
          className="flex items-center gap-2 text-body text-muted-foreground"
        >
          <Trans>Check every</Trans>
          <Input
            id={`${id}-every`}
            type="number"
            min={ROUTINE_WATCH_MIN_MINUTES}
            max={1440}
            value={watch.everyMinutes || ""}
            onChange={(e) =>
              onChange({
                ...watch,
                everyMinutes: Number(e.target.value),
              })
            }
            onBlur={() =>
              onChange({
                ...watch,
                everyMinutes: Math.min(
                  1440,
                  Math.max(ROUTINE_WATCH_MIN_MINUTES, Math.round(watch.everyMinutes)),
                ),
              })
            }
            className="h-8 w-20"
          />
          <Trans>minutes</Trans>
        </label>
        {watch.kind !== "files" ? (
          <label
            htmlFor={`${id}-track`}
            className="block space-y-1.5 text-body text-muted-foreground"
          >
            <span>
              <Trans>Fields to compare (optional)</Trans>
            </span>
            <Input
              id={`${id}-track`}
              placeholder="id, modifiedTime"
              value={watch.track}
              onChange={(e) => onChange({ ...watch, track: e.target.value })}
              className="font-mono text-body-sm"
            />
          </label>
        ) : null}
        <div className="flex items-center gap-2">
          <label
            htmlFor={`${id}-loud`}
            className="flex items-center gap-2 text-body text-muted-foreground"
          >
            <Switch
              id={`${id}-loud`}
              checked={watch.loud}
              onCheckedChange={(loud) => onChange({ ...watch, loud })}
            />
            <Trans>Report unchanged checks</Trans>
          </label>
          <InfoTooltip label={t`Report unchanged checks`}>
            {t`Post a chat message when a check finds no changes. The routine won't run.`}
          </InfoTooltip>
        </div>
        {status ? (
          <p
            data-testid="routine-watch-status"
            className={`text-body-sm ${state?.outcome === "failed" ? "text-destructive" : "text-muted-foreground/80"}`}
          >
            {status}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function MessageTriggerCard({
  provider,
  onRemove,
}: {
  provider: string;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const label =
    provider === "slack"
      ? t`Slack message`
      : provider === "teams"
        ? t`Teams message`
        : t`Message event`;
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <MessageSquare size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">{label}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove message trigger`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <p className="mt-2.5 text-body text-muted-foreground/70">
        <Trans>Runs when this bot receives a verified message from this provider.</Trans>
      </p>
    </div>
  );
}

export function EmailTriggerCard({
  bot,
  domain,
  address,
  senders,
  onChange,
  onRemove,
}: {
  bot: { id: string; name: string };
  /** Null while loading, or when this server no longer receives email. */
  domain: string | null;
  address: string | null;
  senders: RoutineEmailSenders;
  onChange: (senders: RoutineEmailSenders) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const ownerEmail = authClient.useSession().data?.user.email ?? "";
  const ownerDomain = ownerEmail.slice(ownerEmail.lastIndexOf("@") + 1);

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <Mail size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">
          <Trans>When an email arrives</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove email trigger`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {domain ? (
        <div className="mt-2.5 space-y-2.5 text-body">
          <BotEmailAddressField bot={bot} domain={domain} address={address} />
          {ownerDomain ? (
            <NativeSelect
              aria-label={t`Who can start it`}
              className="w-full"
              value={senders}
              onChange={(event) => onChange(event.target.value as RoutineEmailSenders)}
            >
              <NativeSelectOption value="owner">{t`Only me`}</NativeSelectOption>
              <NativeSelectOption value="domain">{t`Anyone at @${ownerDomain}`}</NativeSelectOption>
            </NativeSelect>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function InboundTriggerCard({
  kind,
  saved,
  path,
  secret,
  configured,
  onRemove,
  onRotate,
  onReveal,
  onHide,
}: {
  kind: "webhook" | "github";
  saved: boolean;
  path: string;
  secret: string | null;
  configured: boolean;
  onRemove: () => void;
  onRotate: () => void;
  onReveal: () => void;
  onHide: () => void;
}) {
  const { t } = useLingui();
  const hidden = "••••••••";
  const credential =
    kind === "github"
      ? { label: t`Secret`, value: secret ?? hidden }
      : { label: t`Header`, value: `Authorization: Bearer ${secret ?? hidden}` };

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        {kind === "github" ? (
          <GitBranch size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        ) : (
          <Globe size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        )}
        <span className="flex-1 text-body-lg text-foreground">
          {kind === "github" ? <Trans>Git event</Trans> : <Trans>When a webhook fires</Trans>}
        </span>
        {saved && configured ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Key options`}
                  className="text-muted-foreground"
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto">
              <DropdownMenuItem onClick={onRotate}>
                <RefreshCw />
                <Trans>Rotate key</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={kind === "github" ? t`Remove Git event` : t`Remove webhook`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {saved && configured ? (
        <div className="mt-2.5 space-y-2">
          <CopyRow label={t`URL`} value={path} />
          <CopyRow label={credential.label} value={credential.value} copyable={Boolean(secret)}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={secret ? t`Hide key` : t`Show key`}
              onClick={secret ? onHide : onReveal}
              className="text-muted-foreground"
            >
              {secret ? <EyeOff /> : <Eye />}
            </Button>
          </CopyRow>
        </div>
      ) : (
        <p className="mt-1.5 px-0.5 text-body-sm text-muted-foreground">
          <Trans>Available after saving</Trans>
        </p>
      )}
    </div>
  );
}

/** One labelled value a sender pastes into another service, with a copy button. */
function CopyRow({
  label,
  value,
  copyable = true,
  children,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  /** Extra controls before the copy button. */
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted py-0.5 pr-0.5 pl-2.5">
      <span className="w-14 shrink-0 text-label text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-label text-foreground/75">
        {value}
      </span>
      {children}
      {copyable ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? t`Copied` : t`Copy ${label}`}
          onClick={() => copy(value)}
          className="text-muted-foreground"
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      ) : null}
    </div>
  );
}
