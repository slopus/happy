import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { LoginFieldInput } from "@rakazo/contracts";
import {
  commandVariableName,
  loginCardFields,
  normalizeOneTimeCode,
  vaultKind,
} from "@rakazo/contracts";
import { secretAnswerErrorText } from "@rakazo/i18n/vault";
import { Button, Input } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { AskBlock, AskCardProps } from "./AskCard";
import { BuiCard } from "./ai/primitives";
import { siteHost, VaultTile } from "./vault/kinds";
import { useVaultContacts } from "./vault/use-vault-contacts";
import type { VaultEditorResult } from "./vault/VaultItemEditor";
import { VaultItemEditor } from "./vault/VaultItemEditor";

type FormKind = "login" | "card" | "contact";

function formKind(block: AskBlock): FormKind | undefined {
  const type = block.credential?.auth.type;
  return type === "login" || type === "card" || type === "contact" ? type : undefined;
}

/** A card's editor with the saved contacts it can bill to, loaded only once it opens. */
function CardEditor(props: Parameters<typeof VaultItemEditor>[0]) {
  const contacts = useVaultContacts();
  return <VaultItemEditor {...props} contacts={contacts} />;
}

/**
 * A chat card asking for protected input. A login, card or contact is one row whose Add opens the
 * vault's own form; a code, key or variable is one field, typed right in the card. The value lives
 * only in this card's state and is cleared as soon as it is sent.
 */
export function SecretAskCard({ block, canAnswer, canDismiss, onAnswer, onDismiss }: AskCardProps) {
  const { t } = useLingui();
  const [answer, setAnswer] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [acceptedRemembered, setAcceptedRemembered] = useState<false>();
  const [dismissed, setDismissed] = useState(false);
  const [secretField, setSecretField] = useState<HTMLInputElement | null>(null);
  const [pastedLines, setPastedLines] = useState(false);
  const [pending, setPending] = useState<"submit" | "dismiss" | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = pending !== null;
  const answered = block.status === "answered" || accepted || dismissed;
  const shownDismissed = block.status === "answered" ? block.dismissed : dismissed;
  const shownRemembered = block.status === "answered" ? block.remembered : acceptedRemembered;
  const form = formKind(block);
  const commandInput = block.credential?.auth.type === "command";
  const codeInput = Boolean(block.oneTimeCode);
  const codeHost = block.oneTimeCode ? new URL(block.oneTimeCode.origin).host : undefined;
  // A login, credential or code is for the run's user, so only they can fill one in; others see
  // the card without fields or buttons.
  const ownerOnly = Boolean(block.credential || block.oneTimeCode) && !canDismiss;
  const fieldLabel =
    block.purpose === "password" ? t`Password` : block.purpose === "api_key" ? t`API key` : t`Code`;

  // A password field can't hold line breaks, so it would flatten a multi-line command variable
  // such as an SSH private key. That text is kept as is and the field turns read-only, so what
  // is saved is exactly what was pasted; Clear makes it editable again.
  useEffect(() => {
    if (!commandInput || !secretField) return;
    const field = secretField;
    const keepLineBreaks = (event: InputEvent) => {
      const text = (event.data ?? event.dataTransfer?.getData("text/plain") ?? "").replace(
        /\r\n?/g,
        "\n",
      );
      if (field.readOnly || !event.cancelable || !text.trim().includes("\n")) return;
      event.preventDefault();
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      setAnswer(field.value.slice(0, start) + text + field.value.slice(end));
      setPastedLines(true);
    };
    field.addEventListener("beforeinput", keepLineBreaks);
    return () => field.removeEventListener("beforeinput", keepLineBreaks);
  }, [commandInput, secretField]);

  async function send(value: string, fields?: LoginFieldInput[], remember?: false) {
    setPending("submit");
    setError(null);
    setAnswer("");
    setPastedLines(false);
    try {
      if (remember === false) await onAnswer(value, fields, false);
      else if (fields) await onAnswer(value, fields);
      else await onAnswer(value);
      if (remember === false) setAcceptedRemembered(false);
      setAccepted(true);
    } finally {
      setPending(null);
    }
  }

  async function submitInline() {
    if (submitting || answer.length === 0) return;
    try {
      await send(answer);
    } catch (err) {
      // A secret answer's failure may echo the secret, so only a known fixed message shows.
      setError(secretAnswerErrorText(err, t`Could not submit this answer`));
    }
  }

  async function dismiss() {
    if (submitting) return;
    setPending("dismiss");
    setError(null);
    setAnswer("");
    setPastedLines(false);
    try {
      await onDismiss();
      setDismissed(true);
    } catch (err) {
      setError(t`Could not submit this answer`);
      throw err;
    } finally {
      setPending(null);
    }
  }

  async function saveForm(result: VaultEditorResult) {
    if (form === "login") await send("", result.fields, result.remember);
    else await send(result.value ?? "");
  }

  const status = shownDismissed
    ? t`Dismissed`
    : shownRemembered === false || codeInput
      ? t`Sent`
      : t`Saved`;
  const destination =
    block.credential?.auth.type === "command" ? (
      <span className="flex flex-wrap gap-x-2">
        <span>{t`Command variable`}</span>
        <span className="font-mono">${commandVariableName(block.credential.name)}</span>
      </span>
    ) : codeHost ? (
      t`Only enter a code ${codeHost} sent you.`
    ) : form === "login" && block.credential ? (
      siteHost(block.credential.origin)
    ) : form ? null : (
      block.credential?.origin
    );
  const editorProps = form
    ? {
        open: editorOpen,
        onOpenChange: setEditorOpen,
        kind: form,
        mode: "ask" as const,
        heading: block.text,
        initial:
          form === "login"
            ? {
                origin: block.credential?.origin,
                loginFields: loginCardFields(block.loginFields),
                loginLabels: block.loginFields ?? [t`Username`, t`Password`],
                replacedSite: block.replaces?.origin,
              }
            : undefined,
        onDismiss: canDismiss ? dismiss : undefined,
        onSave: saveForm,
        failureText: (err: unknown) => secretAnswerErrorText(err, t`Could not submit this answer`),
      }
    : undefined;

  return (
    <BuiCard data-testid="secret-ask-card" className="w-full min-w-0 max-w-xl px-4 py-3">
      <div className="flex items-center gap-3">
        <VaultTile
          kind={block.credential ? vaultKind(block.credential.auth.type) : null}
          title={form === "login" && block.credential ? siteHost(block.credential.origin) : ""}
          origin={form === "login" ? block.credential?.origin : undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="text-body-lg font-medium leading-[1.4] text-foreground">
            <ChatMarkdown>{block.text}</ChatMarkdown>
          </div>
          {destination ? (
            <div
              data-testid="secret-ask-destination"
              // A code's line is a sentence, so it wraps between words; an address breaks anywhere.
              className={`${codeHost ? "wrap-anywhere" : "break-all"} text-body-sm text-muted-foreground`}
            >
              {destination}
            </div>
          ) : null}
          {block.sharedBrowser && !ownerOnly && !answered ? (
            <div className="text-body-sm text-muted-foreground">
              {t`The bot's browser stays signed in for everyone in this space`}
            </div>
          ) : null}
          {block.replaces && !ownerOnly && !answered ? (
            <div className="break-all text-body-sm text-muted-foreground">
              {t`Replaces the login saved for ${block.replaces.origin}`}
            </div>
          ) : null}
        </div>
        {answered ? (
          <div className="flex shrink-0 items-center gap-1.5 text-body font-medium text-muted-foreground">
            {shownDismissed ? null : <Check aria-hidden className="size-4" />}
            {status}
          </div>
        ) : form && canAnswer && !ownerOnly ? (
          <Button
            variant="secondary"
            className="shrink-0 rounded-full"
            data-testid="secret-ask-add"
            disabled={submitting}
            onClick={() => {
              setError(null);
              setEditorOpen(true);
            }}
          >
            <Trans>Add</Trans>
          </Button>
        ) : null}
      </div>
      {codeInput && block.detail ? (
        <div className="mt-2 break-words text-body-sm text-muted-foreground">{block.detail}</div>
      ) : null}
      {!answered && !canAnswer ? (
        <div className="mt-2.5 text-body font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : null}
      {!answered && canAnswer && !ownerOnly && !form ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitInline();
          }}
        >
          <Input
            ref={setSecretField}
            className="w-full"
            aria-label={fieldLabel}
            type="password"
            autoComplete={codeInput ? "one-time-code" : "off"}
            spellCheck={false}
            disabled={submitting}
            readOnly={pastedLines}
            value={pastedLines ? answer.replaceAll("\n", " ") : answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={fieldLabel}
          />
          {pastedLines ? (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              disabled={submitting}
              onClick={() => {
                setAnswer("");
                setPastedLines(false);
                secretField?.focus();
              }}
            >
              <Trans>Clear</Trans>
            </Button>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                (codeInput ? !normalizeOneTimeCode(answer) : answer.length === 0) || submitting
              }
            >
              {codeInput ? (
                pending === "submit" ? (
                  <Trans>Sending…</Trans>
                ) : (
                  <Trans>Continue</Trans>
                )
              ) : pending === "submit" ? (
                <Trans>Saving…</Trans>
              ) : (
                <Trans>Save</Trans>
              )}
            </Button>
            {canDismiss ? (
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => void dismiss().catch(() => undefined)}
              >
                <Trans>Dismiss</Trans>
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
      {error ? <p className="mt-2.5 text-body-sm text-destructive">{error}</p> : null}
      {editorProps && editorOpen ? (
        form === "card" ? (
          <CardEditor {...editorProps} />
        ) : (
          <VaultItemEditor {...editorProps} />
        )
      ) : null}
    </BuiCard>
  );
}
