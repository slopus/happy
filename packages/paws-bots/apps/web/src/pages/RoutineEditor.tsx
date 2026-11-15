import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { cronFromPreset } from "@rakazo/core";
import { Button, Input, Switch, Textarea } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, X } from "lucide-react";
import { useId } from "react";
import { useIdentityConfirmation } from "../components/ConfirmIdentityDialog";
import { useSpaceQueries } from "../lib/query";
import type { RoutineDraftState } from "../lib/routine-draft";
import { routineNeedsOneShotArm } from "../lib/routine-draft";
import { RoutineRunHistory } from "./RoutineRunHistory";
import { RoutineSchedule } from "./RoutineSchedule";
import { AddTriggerMenu } from "./routine-editor/add-trigger-menu";
import { RoutineModelSettings } from "./routine-editor/model-settings";
import {
  EmailTriggerCard,
  InboundTriggerCard,
  MessageTriggerCard,
  WatchTriggerCard,
} from "./routine-editor/trigger-cards";

export function RoutineEditor({
  bot,
  draft,
  onChange,
  editing,
  timezone,
  webhook,
  githubPath,
  messageProviders,
  saving,
  running,
  error,
  onBack,
  onClose,
  onSave,
  onTestRun,
  onDelete,
  onEnsureWebhook,
  onRevealWebhook,
  onHideWebhook,
}: {
  bot: { id: string; name: string };
  draft: RoutineDraftState;
  onChange: (next: RoutineDraftState) => void;
  editing: Routine | null;
  timezone: string;
  webhook: { path: string; secret: string | null; configured: boolean };
  githubPath: string;
  messageProviders: string[];
  saving: boolean;
  running: boolean;
  error: string | null;
  onBack: () => void;
  onClose: () => void;
  onSave: () => void;
  onTestRun: () => void;
  onDelete: () => void;
  onEnsureWebhook: () => Promise<void>;
  onRevealWebhook: () => Promise<void>;
  onHideWebhook: () => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  // Closing the confirmation is a choice, and other failures show as the editor's error.
  const revealWebhook = () => void withIdentityConfirmation(onRevealWebhook).catch(() => undefined);
  const queries = useSpaceQueries();
  const scheduleStatus = useQuery({
    ...queries.routines.list.queryOptions({ input: { botId: editing?.botId ?? "" } }),
    enabled: editing !== null && draft.active,
    refetchInterval: 15_000,
    select: (routines) => routines.find((routine) => routine.id === editing?.id) ?? null,
  });
  // Null when this server receives no email or the bot is another member's, which hides the trigger.
  const email = useQuery(queries.bots.emailAddress.queryOptions({ input: { botId: bot.id } })).data;
  const scheduleDelayed =
    !scheduleStatus.isError &&
    (scheduleStatus.data === undefined
      ? editing?.scheduleDelayed
      : scheduleStatus.data?.scheduleDelayed);
  const hasTriggers =
    draft.schedules.length > 0 ||
    draft.webhookEnabled ||
    draft.githubEnabled ||
    Boolean(draft.messageProvider) ||
    Boolean(draft.emailSenders) ||
    Boolean(draft.watch);
  const canTest = Boolean(editing) && !saving && !running;
  const needsOneShotArm =
    editing != null && routineNeedsOneShotArm(editing, draft.schedules.map(cronFromPreset));

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          className="text-muted-foreground"
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Button>
        <div className="text-body-lg font-medium text-foreground">
          <Trans>Routine</Trans>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="text-muted-foreground"
          aria-label={t`Close`}
        >
          <X />
        </Button>
      </div>

      <div className="mb-5 flex items-center justify-between gap-3">
        <label
          htmlFor={`${fieldId}-active`}
          className="flex items-center gap-2.5 text-body text-foreground/75"
        >
          <Switch
            id={`${fieldId}-active`}
            checked={draft.active}
            onCheckedChange={(active) => onChange({ ...draft, active })}
          />
          <Trans>Active</Trans>
        </label>
        <div className="flex items-center gap-2">
          {/* A draft is discarded by going back; only a saved routine can be deleted. */}
          {editing ? (
            <Button variant="secondary" disabled={saving || running} onClick={onDelete}>
              <Trans>Delete</Trans>
            </Button>
          ) : null}
          <Button variant="secondary" disabled={!canTest} onClick={onTestRun}>
            {running ? t`Running…` : t`Run now`}
          </Button>
        </div>
      </div>

      {draft.active && scheduleDelayed ? (
        <p role="status" className="mb-5 text-body text-warning">
          <Trans>Schedule delayed</Trans>
        </p>
      ) : null}

      <label htmlFor={`${fieldId}-name`} className="block text-body text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={`${fieldId}-name`}
          value={draft.name}
          placeholder={t`Name this routine`}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          className="mt-2"
        />
      </label>

      <label htmlFor={`${fieldId}-prompt`} className="mt-5 block text-body text-muted-foreground">
        <Trans>Instruction</Trans>
        <Textarea
          id={`${fieldId}-prompt`}
          value={draft.prompt}
          placeholder={t`What should this routine do each time it runs?`}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
          rows={4}
          className="mt-2"
        />
      </label>

      <div className="mt-5 text-body text-muted-foreground">
        <div className="flex items-center gap-2">
          <Trans>When to run</Trans>
          <span className="text-label text-muted-foreground/70">{timezone}</span>
          <RoutineModelSettings draft={draft} onChange={onChange} fieldId={fieldId} />
        </div>

        <div className="mt-2 space-y-2">
          {draft.schedules.map((preset, index) => (
            <RoutineSchedule
              key={index}
              value={preset}
              onChange={(next) =>
                onChange({
                  ...draft,
                  schedules: draft.schedules.map((item, i) => (i === index ? next : item)),
                })
              }
              onRemove={() =>
                onChange({ ...draft, schedules: draft.schedules.filter((_, i) => i !== index) })
              }
            />
          ))}

          {draft.webhookEnabled ? (
            <InboundTriggerCard
              kind="webhook"
              saved={Boolean(editing)}
              path={webhook.path}
              secret={webhook.secret}
              configured={webhook.configured}
              onRemove={() => onChange({ ...draft, webhookEnabled: false })}
              onRotate={() => void onEnsureWebhook()}
              onReveal={revealWebhook}
              onHide={onHideWebhook}
            />
          ) : null}

          {draft.githubEnabled ? (
            <InboundTriggerCard
              kind="github"
              saved={Boolean(editing)}
              path={githubPath}
              secret={webhook.secret}
              configured={webhook.configured}
              onRemove={() => onChange({ ...draft, githubEnabled: false })}
              onRotate={() => void onEnsureWebhook()}
              onReveal={revealWebhook}
              onHide={onHideWebhook}
            />
          ) : null}

          {draft.watch ? (
            <WatchTriggerCard
              watch={draft.watch}
              state={editing?.watch ? editing.watchState : null}
              onChange={(watch) => onChange({ ...draft, watch })}
              onRemove={() => onChange({ ...draft, watch: null })}
            />
          ) : null}

          {draft.messageProvider ? (
            <MessageTriggerCard
              provider={draft.messageProvider}
              onRemove={() => onChange({ ...draft, messageProvider: null })}
            />
          ) : null}

          {/* Shown without email too, so a server that stopped receiving mail still lets it go. */}
          {draft.emailSenders ? (
            <EmailTriggerCard
              key={bot.id}
              bot={bot}
              domain={email?.domain ?? null}
              address={email?.address ?? null}
              senders={draft.emailSenders}
              onChange={(emailSenders) => onChange({ ...draft, emailSenders })}
              onRemove={() => onChange({ ...draft, emailSenders: null })}
            />
          ) : null}

          {needsOneShotArm ? (
            <label htmlFor={`${fieldId}-run-at`} className="block text-body text-muted-foreground">
              <Trans>Run at</Trans>
              <Input
                id={`${fieldId}-run-at`}
                type="datetime-local"
                value={draft.runAtLocal}
                onChange={(e) => onChange({ ...draft, runAtLocal: e.target.value })}
                aria-label={t`Run at`}
                className="mt-2"
              />
            </label>
          ) : null}
        </div>

        <AddTriggerMenu
          draft={draft}
          onChange={onChange}
          fieldId={fieldId}
          messageProviders={messageProviders}
          emailAvailable={Boolean(email)}
          webhookConfigured={webhook.configured}
          onEnsureWebhook={onEnsureWebhook}
        />
      </div>

      <div className="mt-5">
        <Button disabled={saving || running || !hasTriggers} onClick={onSave}>
          {saving ? t`Saving…` : t`Save`}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}

      {editing ? <RoutineRunHistory key={editing.id} routineId={editing.id} /> : null}
      {identityDialog}
    </div>
  );
}
