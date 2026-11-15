import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentImportMemoryDestination,
  AgentImportPlan,
  AgentImportSkipReason,
  AgentImportStatus,
  AgentImportWarning,
  ComputerMode,
} from "@rakazo/contracts";
import { BOT_DESCRIPTION_MAX_LENGTH, BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { looksLikeCredential } from "@rakazo/core";
import { Button, Checkbox, Input, Label, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { ComputerModePicker } from "./bot-settings-sections";
import { useImportStatusText } from "./import-status";
import type { AgentImportSource } from "./use-agent-import-source";

/** Warnings the status label already says. */
const STATUS_WARNINGS: ReadonlySet<AgentImportWarning> = new Set([
  "needs_setup",
  "unsupported_command",
  "local_path",
  "bundled_files",
]);

export const sectionClass = "mt-6";
export const headingClass = "text-body text-foreground";

/** What a read source would import, with a box per item, then the new bot's name and Create. */
export function AgentImportPlanReview({
  ids,
  plan,
  source,
  computerMode,
  onComputerModeChange,
  onCreate,
}: {
  ids: string;
  plan: AgentImportPlan;
  source: AgentImportSource;
  computerMode: ComputerMode;
  onComputerModeChange: (mode: ComputerMode) => void;
  onCreate: () => void;
}) {
  const { t } = useLingui();
  const statusText = useImportStatusText();
  const {
    unchecked,
    toggle,
    destinations,
    setDestinations,
    name,
    setName,
    description,
    setDescription,
    busy,
    includeSecrets,
    secretsAvailable,
    toggleSecrets,
    modelUsable,
    tooLong,
    ready,
  } = source;

  const item = (
    id: string,
    title: string,
    content: string,
    extra?: ReactNode,
    description?: string,
    disabled = false,
  ) => (
    <li key={id} className="py-1">
      <Collapsible>
        <div className="flex min-h-9 flex-wrap items-center gap-x-3">
          <Checkbox
            aria-label={title}
            checked={!disabled && !unchecked.has(id)}
            disabled={disabled}
            onCheckedChange={(checked) => toggle(id, checked)}
          />
          <CollapsibleTrigger className="group flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-start text-body text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <span className="truncate" dir="auto">
              {title}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-aria-expanded:rotate-0 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          {extra}
        </div>
        <CollapsibleContent>
          <div className="ms-7 mt-1" data-testid="agent-import-content">
            {description ? (
              <p className="mb-1 text-body-sm text-muted-foreground" dir="auto">
                {description}
              </p>
            ) : null}
            <pre
              className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-3 py-2 font-mono text-label text-foreground"
              dir="auto"
            >
              {content}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );

  const defaultNote = plan.source === "hermes" ? t`Default from Hermes` : t`Default from OpenClaw`;
  // Never the matched text: the expanded item shows the user's own text, unchanged.
  const keyNote = t`Looks like it contains a key`;
  // A label that itself looks like a key is replaced by its kind and position.
  const safeLabel = (label: string, containsKey: boolean | undefined, fallback: string) =>
    containsKey && looksLikeCredential(label) ? fallback : label;
  const skillLabel = (index: number) => {
    const position = index + 1;
    return t`Skill ${position}`;
  };
  const skipReason = (reason: AgentImportSkipReason) =>
    ({
      runtime: t`Not used by Rakazo`,
      invalid_skill: t`Not a valid skill`,
      builtin: t`Built-in`,
      unsupported: t`Not supported in Rakazo`,
      connected: t`Already connected`,
      invalid_file: t`Could not read these files`,
      default: defaultNote,
      reconnect: t`Connect it again`,
    })[reason];
  const warningText = (warning: AgentImportWarning) =>
    warning === "runs_code"
      ? t`Contains code to run`
      : warning === "dropped_settings"
        ? t`Some settings are not imported`
        : warning === "changed_schedule"
          ? t`Timing may differ`
          : null;
  const statusNote = (status: AgentImportStatus, warnings: AgentImportWarning[]) => {
    const others = warnings.filter(
      (warning) =>
        !STATUS_WARNINGS.has(warning) &&
        !(warning === "runs_code" && status.kind === "needs_review"),
    );
    // Ready is what a ticked box already says: only exceptions get a label.
    const label = [
      status.kind === "ready" ? null : statusText.status(status),
      ...others.map(warningText),
    ]
      .filter(Boolean)
      .join(", ");
    return label ? note(label) : undefined;
  };
  // Its own line under the name, so a long status never cuts the name short.
  const note = (text: string) => (
    <span className="ms-7 -mt-1 mb-1 basis-full text-body-sm text-muted-foreground" dir="auto">
      {text}
    </span>
  );

  return (
    <div data-testid="agent-import-preview">
      {plan.instructions.length ? (
        <section className={sectionClass} data-testid="agent-import-instructions">
          <h3 className={headingClass}>
            <Trans>Instructions</Trans>
          </h3>
          <ul className="mt-2">
            {plan.instructions.map((entry, index) => {
              const mentions = entry.mentions.join(", ");
              const position = index + 1;
              return item(
                entry.id,
                safeLabel(entry.title, entry.containsKey, t`Instructions ${position}`),
                entry.content,
                note(
                  [
                    entry.role === "persona" ? t`Persona` : t`Working instructions`,
                    entry.containsKey ? keyNote : null,
                    entry.stock ? defaultNote : mentions ? t`Mentions OpenClaw features` : null,
                  ]
                    .filter(Boolean)
                    .join(", "),
                ),
                mentions ? t`Mentions: ${mentions}` : undefined,
              );
            })}
          </ul>
          {tooLong ? (
            <p role="alert" className="mt-2 text-body-sm text-destructive">
              <Trans>Instructions are too long. Untick some files.</Trans>
            </p>
          ) : null}
        </section>
      ) : null}
      {plan.memory.length ? (
        <section className={sectionClass} data-testid="agent-import-memory">
          <h3 className={headingClass}>
            <Trans>Memory</Trans>
          </h3>
          <ul className="mt-2">
            {plan.memory.map((entry, index) => {
              const { spacePath: savedAs } = entry;
              const position = index + 1;
              const fallback = t`Memory ${position}`;
              const title = safeLabel(entry.title, entry.containsKey, fallback);
              const destination = destinations[entry.id] ?? "bot";
              const renamed = destination === "space" && savedAs !== entry.path;
              return item(
                entry.id,
                safeLabel(
                  renamed ? t`${title}, saved as ${savedAs}` : title,
                  entry.containsKey,
                  fallback,
                ),
                entry.content,
                <>
                  <NativeSelect
                    size="sm"
                    aria-label={t`Memory for ${title}`}
                    value={destination}
                    disabled={unchecked.has(entry.id)}
                    onChange={(event) =>
                      setDestinations((current) => ({
                        ...current,
                        [entry.id]: event.target.value as AgentImportMemoryDestination,
                      }))
                    }
                  >
                    <NativeSelectOption value="bot">{t`This bot`}</NativeSelectOption>
                    <NativeSelectOption value="space">{t`All bots`}</NativeSelectOption>
                  </NativeSelect>
                  {entry.containsKey || entry.stock
                    ? note(
                        [entry.containsKey ? keyNote : null, entry.stock ? defaultNote : null]
                          .filter(Boolean)
                          .join(", "),
                      )
                    : null}
                </>,
              );
            })}
          </ul>
        </section>
      ) : null}
      {plan.skills.length ? (
        <section className={sectionClass} data-testid="agent-import-skills">
          <h3 className={headingClass}>
            <Trans>Skills</Trans>
          </h3>
          <p className="mt-1 text-body-sm text-muted-foreground">
            <Trans>Skills join the library all your bots share.</Trans>
          </p>
          <ul className="mt-2">
            {plan.skills.map(
              (
                { id, title, name: savedAs, content, description, warnings, status, containsKey },
                index,
              ) =>
                item(
                  id,
                  safeLabel(
                    savedAs === title ? title : t`${title}, saved as ${savedAs}`,
                    containsKey,
                    skillLabel(index),
                  ),
                  content,
                  <>
                    {containsKey ? note(keyNote) : null}
                    {statusNote(status, warnings)}
                  </>,
                  description,
                  status.kind === "unsupported",
                ),
            )}
          </ul>
        </section>
      ) : null}
      {plan.model ? (
        <section className={sectionClass} data-testid="agent-import-model">
          <h3 className={headingClass}>
            <Trans>Model</Trans>
          </h3>
          <ul className="mt-2">
            {item(
              plan.model.id,
              plan.model.title,
              `${plan.model.provider}\n${plan.model.modelId}`,
              modelUsable
                ? undefined
                : note(
                    statusText.status(
                      plan.model.status === "unknown"
                        ? { kind: "unsupported", reason: "not_in_catalog" }
                        : {
                            kind: "needs_setup",
                            needs: [
                              {
                                kind: "api_key",
                                provider: plan.model.providerName ?? plan.model.provider,
                              },
                            ],
                          },
                    ),
                  ),
              undefined,
              !modelUsable,
            )}
          </ul>
        </section>
      ) : null}
      {plan.mcpServers.length ? (
        <section className={sectionClass} data-testid="agent-import-mcp">
          <h3 className={headingClass}>
            <Trans>MCP servers</Trans>
          </h3>
          <ul className="mt-2">
            {plan.mcpServers.map(({ id, title, name: savedAs, content, warnings, status }) =>
              item(
                id,
                savedAs === title ? title : t`${title}, saved as ${savedAs}`,
                content,
                statusNote(status, warnings),
                undefined,
                status.kind === "unsupported",
              ),
            )}
          </ul>
        </section>
      ) : null}
      {plan.routines.length ? (
        <section className={sectionClass} data-testid="agent-import-routines">
          <h3 className={headingClass}>
            <Trans>Routines</Trans>
          </h3>
          <ul className="mt-2">
            {plan.routines.map((entry) =>
              item(entry.id, entry.title, entry.content, statusNote(entry.status, entry.warnings)),
            )}
          </ul>
        </section>
      ) : null}
      {secretsAvailable ? (
        <section className={sectionClass} data-testid="agent-import-keys">
          <Label className="min-h-9 gap-3 font-normal text-body text-foreground">
            <Checkbox
              checked={includeSecrets}
              disabled={busy}
              onCheckedChange={(checked) => void toggleSecrets(checked)}
            />
            <Trans>Include API keys</Trans>
          </Label>
          {plan.apiKeys.length ? (
            <>
              <h3 className={`mt-3 ${headingClass}`}>
                <Trans>API keys</Trans>
              </h3>
              <ul className="mt-2">
                {plan.apiKeys.map((entry) => item(entry.id, entry.title, entry.provider))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
      {plan.skipped.length ? (
        <Collapsible className={sectionClass} data-testid="agent-import-skipped">
          <h3 className={headingClass}>
            <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded-sm text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <Trans>Not imported</Trans>
              <ChevronDown
                aria-hidden="true"
                className="size-4 -rotate-90 text-muted-foreground transition-transform group-aria-expanded:rotate-0 motion-reduce:transition-none"
              />
            </CollapsibleTrigger>
          </h3>
          <CollapsibleContent>
            <ul className="mt-2 text-body-sm text-muted-foreground">
              {plan.skipped.map((entry, index) => (
                <li key={`${index}:${entry.path}`} className="py-1">
                  <span>{entry.path}</span>
                  <span className="ml-2 text-muted-foreground/70">{skipReason(entry.reason)}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <label htmlFor={`${ids}-name`} className={`mt-6 block ${headingClass}`}>
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(event) => setName(event.target.value)}
          placeholder={t`Name this bot`}
          className="mt-2"
        />
      </label>
      {plan.suggestedDescription ? (
        <label htmlFor={`${ids}-description`} className={`mt-6 block ${headingClass}`}>
          <Trans>Description</Trans>
          <Input
            id={`${ids}-description`}
            value={description}
            maxLength={BOT_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
            className="mt-2"
          />
        </label>
      ) : null}
      <ComputerModePicker value={computerMode} onChange={onComputerModeChange} />
      <div className="mt-5">
        <Button disabled={!ready || busy} onClick={onCreate}>
          {busy ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
        </Button>
      </div>
    </div>
  );
}
