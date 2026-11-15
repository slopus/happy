import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AutomatedSenderPolicies,
  AutomatedSenderPolicyMode,
  Bot,
  ExternalConversation,
  ExternalConversationPolicy,
} from "@rakazo/contracts";
import type { ListenMode } from "@rakazo/core";
import {
  AUTOMATED_SENDER_MODES,
  ambientValue,
  listenMode,
  roomAutomatedSenders,
  senderPolicy,
  withRollupHours,
  withSenderMode,
} from "@rakazo/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@rakazo/ui-web";
import { RotateCcw } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { SuccessPop } from "../components/ai/primitives";
import { errorText } from "../lib/user-error";

export function ExternalConversationSettings({
  conversation,
  bot,
  onSave,
}: {
  conversation: ExternalConversation;
  bot: Bot;
  onSave: (policy: ExternalConversationPolicy) => Promise<void>;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [mode, setMode] = useState<ListenMode>(() =>
    listenMode(conversation.teamChatAmbientEnabled),
  );
  const [rules, setRules] = useState<string | null>(conversation.teamChatRules || null);
  const [policies, setPolicies] = useState<AutomatedSenderPolicies>(
    conversation.automatedSenderPolicies,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The draft this render would save; an edit made while a save is in flight
  // changes it, and that newer draft is still unsaved when the save lands.
  const draftJson = JSON.stringify({
    teamChatAmbientEnabled: ambientValue(mode),
    teamChatRules: rules,
    automatedSenderPolicies: policies,
  });
  const latestDraftJson = useRef(draftJson);
  latestDraftJson.current = draftJson;
  const senders = useMemo(
    () => roomAutomatedSenders(policies, conversation.automatedSenders),
    [conversation.automatedSenders, policies],
  );
  const botName = bot.name;
  const replyChoices: Array<{ value: ListenMode; label: string }> = [
    { value: "inherit", label: t`Same as ${botName}` },
    { value: "listen", label: t`Every message` },
    { value: "mentions", label: t`Mentions only` },
  ];
  const effectiveMode = (ambientValue(mode) ?? bot.teamChatAmbientEnabled) ? "listen" : "mentions";
  const senderModeLabels: Record<AutomatedSenderPolicyMode, string> = {
    ignore: t`Ignore`,
    rollup: t`Group updates`,
    action: t`Always act`,
    user: t`Treat like a person`,
  };

  function updatePolicies(update: (current: AutomatedSenderPolicies) => AutomatedSenderPolicies) {
    setSaved(false);
    setPolicies(update);
  }

  return (
    <div data-testid="external-conversation-settings">
      <div className="mb-6">
        <SectionHeading as="h2" variant="heading" className="truncate" dir="auto">
          {conversation.displayName || t`External conversation`}
        </SectionHeading>
        <p className="mt-1 truncate text-body-sm text-muted-foreground">
          {conversation.participantNames.join(", ")}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span id={`${fieldId}-replies`} className="text-body text-foreground">
          <Trans>Replies to</Trans>
        </span>
        <Select
          value={mode}
          onValueChange={(next) => {
            if (!next) return;
            setMode(next as ListenMode);
            setSaved(false);
          }}
          items={replyChoices}
        >
          <SelectTrigger size="sm" aria-labelledby={`${fieldId}-replies`}>
            <SelectValue>
              {replyChoices.find((choice) => choice.value === effectiveMode)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="end">
            <SelectGroup>
              {replyChoices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <label htmlFor={`${fieldId}-rules`} className="mt-6 block text-body text-muted-foreground">
        <span className="flex min-h-7 items-center justify-between gap-3">
          <Trans>Instructions for this room</Trans>
          {rules !== null ? (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setRules(null);
                setSaved(false);
              }}
              className="shrink-0 text-muted-foreground"
            >
              <RotateCcw size={14} strokeWidth={1.8} />
              <Trans>Reset</Trans>
            </Button>
          ) : null}
        </span>
        <Textarea
          id={`${fieldId}-rules`}
          value={rules ?? ""}
          maxLength={4000}
          onChange={(event) => {
            // An emptied field follows the bot again, as its placeholder shows.
            setRules(event.target.value || null);
            setSaved(false);
          }}
          placeholder={bot.teamChatRules || undefined}
          rows={6}
          className="mt-2 min-h-36 resize-y"
        />
      </label>

      {senders.length > 0 ? (
        <div className="mt-6 border-t border-border pt-5">
          <h3 className="text-body text-muted-foreground">
            <Trans>Automated senders</Trans>
          </h3>
          <div className="mt-2 divide-y divide-border">
            {senders.map((sender) => {
              const policy = senderPolicy(policies, sender);
              return (
                <div key={sender.id} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-body text-foreground">
                      {sender.name}
                    </span>
                    <NativeSelect
                      size="sm"
                      aria-label={t`${sender.name} handling`}
                      value={policy.mode}
                      onChange={(event) =>
                        updatePolicies((current) =>
                          withSenderMode(
                            current,
                            sender,
                            event.target.value as AutomatedSenderPolicyMode,
                          ),
                        )
                      }
                      className="max-w-[165px]"
                    >
                      {AUTOMATED_SENDER_MODES.map((value) => (
                        <NativeSelectOption key={value} value={value}>
                          {senderModeLabels[value]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  {policy.mode === "rollup" ? (
                    <label
                      htmlFor={`${fieldId}-${sender.id}-rollup`}
                      className="mt-2 flex items-center justify-end gap-2 text-label text-muted-foreground"
                    >
                      <Trans>Every</Trans>
                      <Input
                        id={`${fieldId}-${sender.id}-rollup`}
                        aria-label={t`${sender.name} rollup hours`}
                        type="number"
                        min={1}
                        max={720}
                        value={policy.rollupHours ?? 6}
                        onChange={(event) =>
                          updatePolicies((current) =>
                            withRollupHours(current, sender, Number(event.target.value)),
                          )
                        }
                        className="h-7 w-16 px-2 text-end"
                      />
                      <Trans>hours</Trans>
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-body-sm text-destructive">{error}</p> : null}
      <div className="mt-6 flex min-h-10 items-center gap-3">
        <Button
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setSaved(false);
            setError(null);
            const savedJson = draftJson;
            void onSave({
              teamChatAmbientEnabled: ambientValue(mode),
              teamChatRules: rules,
              automatedSenderPolicies: policies,
            })
              .then(() => {
                // Only the draft the save carried is confirmed; one edited
                // meanwhile stays unsaved, without a false "Saved" marker.
                if (latestDraftJson.current === savedJson) setSaved(true);
              })
              .catch((cause) => setError(errorText(cause, t`Could not save`)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? <Trans>Saving...</Trans> : <Trans>Save</Trans>}
        </Button>
        {saved ? <SuccessPop label={t`Saved`} /> : null}
      </div>
    </div>
  );
}
