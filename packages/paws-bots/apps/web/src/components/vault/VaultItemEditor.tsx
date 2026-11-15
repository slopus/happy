import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CardSecretValue,
  ContactFields,
  LoginFieldInput,
  VaultKind,
  VaultPolicy,
} from "@rakazo/contracts";
import {
  BotSecretName,
  CardSecretValue as CardSecretValueSchema,
  ContactSecretValue,
  cardBrand,
  commandVariableName,
  commandVariableProblem,
  encodeCardSecret,
  encodeContactSecret,
  parseCardExpiry,
  VAULT_ALSO_ON_LIMIT,
} from "@rakazo/contracts";
import { vaultLoginSave } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import type { AgentAccess } from "../integrations/agent-access";
import type { VaultAuth } from "./kinds";
import { LoginFieldsInput } from "./LoginFieldsInput";
import { VaultItemAccess } from "./VaultItemAccess";
import { VaultPageHeader } from "./VaultPageHeader";

/** What the editor hands back: a destination and the value to save, in the shape vault.put takes. */
export type VaultEditorResult = {
  destination: { name?: string; origin: string; auth: VaultAuth };
  /** Encoded for its kind; undefined keeps the saved value (an edit that left it empty). */
  value?: string;
  /** A login's fields as typed, which a chat card answers with. */
  fields?: LoginFieldInput[];
  /** A chat login card the person chose to use once, not save. */
  remember?: false;
  title?: string;
  note?: string;
  policy?: VaultPolicy;
  allBots?: boolean;
  botIds?: string[];
  alsoOn?: string[];
};

/** What the form starts with: a saved item being edited, or what a chat card asks for. */
export type VaultEditorInitial = {
  name?: string;
  title?: string;
  note?: string;
  origin?: string;
  auth?: VaultAuth;
  loginFields?: LoginFieldInput[];
  otp?: string;
  /** What a chat card's login fields are called on screen. */
  loginLabels?: readonly string[];
  /** The site of the saved login a chat card's answer moves to this one, shown before saving. */
  replacedSite?: string;
  card?: CardSecretValue;
  contact?: ContactFields;
  policy?: VaultPolicy;
  /** Left out by a server that can't limit an item to chosen bots. */
  access?: AgentAccess;
  botsNote?: string;
  alsoOn?: string[];
};

/** A saved contact a card can bill to. */
export type BillingContact = { name: string; title: string };

type ApiAuthType = "bearer" | "header" | "basic";
type ContactInput = Record<keyof ContactFields, string>;

const EMPTY_CONTACT: ContactInput = {
  name: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  phone: "",
  email: "",
};

function digitsOf(text: string, max: number) {
  return text.replace(/\D/g, "").slice(0, max);
}

/** Card digits in groups of four, as printed on most cards. */
function groupedCardNumber(digits: string) {
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function expiryText(card: Pick<CardSecretValue, "expMonth" | "expYear">) {
  return `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

function FormField({
  label,
  children,
  id,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  id: string;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={id} className="text-body-sm font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * The form for one vault item in a dialog, as chat opens it. Settings shows the same form in its
 * own panel with VaultItemEditorPage, so no dialog opens over the Settings dialog.
 * The form is shared by Settings and chat. `new` and `edit` save to
 * the vault; `ask` answers a chat card, which carries no title or note. Protected values are held
 * only here and cleared as soon as a save starts.
 */
export function VaultItemEditor({
  open,
  onOpenChange,
  ...props
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & EditorFormProps) {
  // A save in flight keeps the dialog open, so its result has somewhere to show.
  const busyRef = useRef(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !busyRef.current && onOpenChange(next)}>
      <DialogContent data-testid="vault-editor" className="sm:max-w-md">
        <EditorForm
          {...props}
          busyRef={busyRef}
          onDone={() => onOpenChange(false)}
          header={
            <DialogHeader>
              <DialogTitle className="pe-8 text-body-lg">{props.heading}</DialogTitle>
            </DialogHeader>
          }
        />
      </DialogContent>
    </Dialog>
  );
}

/** The same form in Settings → Vault's own panel, in place of the list. */
export function VaultItemEditorPage({
  onBack,
  ...props
}: { onBack: () => void } & EditorFormProps) {
  // A save in flight keeps the form, so its result has somewhere to show.
  const busyRef = useRef(false);
  return (
    <div data-testid="vault-editor">
      <EditorForm
        {...props}
        busyRef={busyRef}
        onDone={onBack}
        header={
          <VaultPageHeader title={props.heading} onBack={() => !busyRef.current && onBack()} />
        }
      />
    </div>
  );
}

type EditorFormProps = {
  kind: VaultKind;
  mode: "new" | "edit" | "ask";
  heading: string;
  initial?: VaultEditorInitial;
  /** Saved contacts a card can bill to; none hides the choice. */
  contacts?: BillingContact[];
  /** Turns down a chat card instead of answering it. */
  onDismiss?: () => Promise<void>;
  onSave: (result: VaultEditorResult) => Promise<void>;
  /** The message for a failed save; a chat card's never quotes the server, which may echo a value. */
  failureText: (error: unknown) => string;
};

type InputExtras = Partial<ComponentProps<typeof Input>> & { "data-testid"?: string };

function EditorForm({
  kind,
  mode,
  initial,
  contacts,
  onDismiss,
  onSave,
  failureText,
  busyRef,
  onDone,
  header,
}: EditorFormProps & { busyRef: { current: boolean }; onDone: () => void; header: ReactNode }) {
  const { t } = useLingui();
  const ids = useId();
  const editing = mode === "edit";
  const asking = mode === "ask";
  const [title, setTitle] = useState(initial?.title ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [noteShown, setNoteShown] = useState(Boolean(initial?.note));
  const [policy, setPolicy] = useState(initial?.policy ?? "allow");
  const [access, setAccess] = useState(initial?.access);
  // Bots offered only once known take the saved choice then; withdrawn, nothing is sent.
  const [offered, setOffered] = useState(initial?.access);
  if (offered !== initial?.access) {
    setOffered(initial?.access);
    setAccess(initial?.access);
  }
  const [origin, setOrigin] = useState(initial?.origin ?? "");
  const savedAlsoOn = initial?.alsoOn?.join(", ") ?? "";
  const [alsoOn, setAlsoOn] = useState(savedAlsoOn);
  const [otp, setOtp] = useState(initial?.otp ?? "");
  const [otpShown, setOtpShown] = useState(Boolean(initial?.otp));
  const [alsoOnShown, setAlsoOnShown] = useState(Boolean(savedAlsoOn));
  const defaultLogin = (): LoginFieldInput[] =>
    initial?.loginFields?.map((field) => ({ ...field, value: asking ? "" : field.value })) ?? [
      { label: t`Username`, value: "", hidden: false },
      { label: t`Password`, value: "", hidden: true },
    ];
  const [login, setLogin] = useState(defaultLogin);
  const [remember, setRemember] = useState(true);
  const [cardNumber, setCardNumber] = useState(initial?.card?.number ?? "");
  const [expiry, setExpiry] = useState(initial?.card ? expiryText(initial.card) : "");
  const [cvc, setCvc] = useState(initial?.card?.cvc ?? "");
  const [cardName, setCardName] = useState(initial?.card?.name ?? "");
  // A billing contact removed since the card was saved reads as none, so a save drops it.
  const [billing, setBilling] = useState(() => {
    const saved = initial?.card?.billing ?? "";
    return contacts?.some((contact) => contact.name === saved) ? saved : "";
  });
  const [contact, setContact] = useState<ContactInput>({
    ...EMPTY_CONTACT,
    ...Object.fromEntries(
      Object.entries(initial?.contact ?? {}).filter(([, value]) => value !== undefined),
    ),
  });
  const initialAuth = initial?.auth;
  const [apiType, setApiType] = useState<ApiAuthType>(
    initialAuth?.type === "header" || initialAuth?.type === "basic" ? initialAuth.type : "bearer",
  );
  const [headerName, setHeaderName] = useState(
    initialAuth?.type === "header" ? initialAuth.name : "",
  );
  const [basicUsername, setBasicUsername] = useState(
    initialAuth?.type === "basic" ? initialAuth.username : "",
  );
  const [variable, setVariable] = useState(
    kind === "variable" && initial?.name ? commandVariableName(initial.name) : "",
  );
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = (field: string) => `${ids}-${field}`;

  function clearProtected() {
    setLogin((fields) => fields.map((field) => ({ ...field, value: "" })));
    setOtp("");
    setCardNumber("");
    setCvc("");
    setValue("");
  }

  const cardDigits = digitsOf(cardNumber, 19);
  const brand = cardDigits ? cardBrand(cardDigits) : "Card";
  const parsedExpiry = parseCardExpiry(expiry);
  const card = CardSecretValueSchema.safeParse({
    number: cardDigits,
    expMonth: parsedExpiry?.expMonth ?? 0,
    expYear: parsedExpiry?.expYear ?? 0,
    cvc,
    name: cardName,
    ...(billing ? { billing } : {}),
  });
  const contactValue = ContactSecretValue.safeParse(contact);
  const variableHandle = variable.trim().toLowerCase();
  const variableValid = BotSecretName.safeParse(variableHandle).success;
  const exported = variableValid ? commandVariableName(variableHandle) : null;
  const reserved = exported ? commandVariableProblem(exported) : undefined;
  const commandVariable = exported ? `$${exported}` : null;
  // An edit keeps the saved value of a key or variable when its field is left empty.
  const valueReady = value.length > 0 || editing;
  // The same rules as the mobile editor's.
  const loginSave = vaultLoginSave({
    fields: login,
    otp,
    savedOtp: initial?.otp ?? "",
    alsoOn,
    savedAlsoOn,
    asking,
  });
  const { keyUnreadable, sites: otherSites } = loginSave;
  const limit = VAULT_ALSO_ON_LIMIT;

  const ready =
    kind === "login"
      ? origin.trim().length > 0 && loginSave.save !== undefined
      : kind === "card"
        ? card.success
        : kind === "contact"
          ? contactValue.success
          : kind === "api_key"
            ? origin.trim().length > 0 &&
              (apiType !== "header" || headerName.trim().length > 0) &&
              (apiType !== "basic" || basicUsername.trim().length > 0) &&
              valueReady
            : variableValid && !reserved && valueReady;

  function result(): VaultEditorResult {
    // A title is sent only when it changed: a saved item shows one read from it when it has none
    // of its own, and keeping that would freeze it when the card or contact changes later.
    const titleChanged = title.trim() !== (initial?.title ?? "");
    const labels = asking
      ? {}
      : {
          ...(titleChanged ? { title: title.trim() } : {}),
          ...(noteShown || editing ? { note: note.trim() } : {}),
          ...(policy !== (initial?.policy ?? "allow") ? { policy } : {}),
          ...(access && access !== initial?.access ? access : {}),
        };
    const name = initial?.name;
    if (kind === "login") {
      return {
        destination: { name, origin: origin.trim(), auth: { type: "login" } },
        value: loginSave.save?.value,
        fields: login,
        ...(asking && !remember ? { remember: false as const } : {}),
        ...(loginSave.save?.alsoOn ? { alsoOn: loginSave.save.alsoOn } : {}),
        ...labels,
      };
    }
    if (kind === "card") {
      return {
        destination: { name, origin: "", auth: { type: "card" } },
        value: card.success ? encodeCardSecret(card.data) : undefined,
        ...labels,
      };
    }
    if (kind === "contact") {
      return {
        destination: { name, origin: "", auth: { type: "contact" } },
        value: contactValue.success ? encodeContactSecret(contactValue.data) : undefined,
        ...labels,
      };
    }
    if (kind === "api_key") {
      const auth: VaultAuth =
        apiType === "header"
          ? { type: "header", name: headerName.trim() }
          : apiType === "basic"
            ? { type: "basic", username: basicUsername.trim() }
            : { type: "bearer" };
      return {
        destination: { name, origin: origin.trim(), auth },
        value: value || undefined,
        ...labels,
      };
    }
    return {
      destination: { name: name ?? variableHandle, origin: "", auth: { type: "command" } },
      value: value || undefined,
      ...labels,
    };
  }

  async function submit() {
    if (busy || !ready) return;
    const saving = result();
    const typedKey = otp;
    clearProtected();
    setError(null);
    setBusy(true);
    busyRef.current = true;
    try {
      await onSave(saving);
      onDone();
    } catch (err) {
      // Kept, so saving again after fixing the password doesn't remove the key.
      setOtp(typedKey);
      setError(failureText(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy || !onDismiss) return;
    clearProtected();
    setBusy(true);
    try {
      await onDismiss();
      onDone();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  const text = (
    field: string,
    label: ReactNode,
    state: string,
    set: (next: string) => void,
    props: InputExtras = {},
    className?: string,
  ) => (
    <FormField id={id(field)} label={label} className={className}>
      <Input
        id={id(field)}
        value={state}
        spellCheck={false}
        autoComplete="off"
        {...props}
        // After the spread, so a field that is otherwise editable still locks while a save runs.
        disabled={busy || props.disabled}
        onChange={(event) => set(event.target.value)}
      />
    </FormField>
  );

  const siteField = (placeholder: string) =>
    text("site", t`Site`, origin, setOrigin, {
      placeholder,
      // The destination of a saved or requested item is fixed.
      disabled: editing || asking,
      "data-testid": "vault-editor-site",
    });

  const contactField = (field: keyof ContactFields, label: string, className?: string) =>
    text(
      `contact-${field}`,
      label,
      contact[field],
      (next) => setContact((current) => ({ ...current, [field]: next })),
      field === "email" ? { type: "email" } : field === "phone" ? { type: "tel" } : {},
      className,
    );

  const protectedValue = (label: string, placeholder?: string) => (
    <FormField id={id("value")} label={label}>
      <Input
        id={id("value")}
        data-testid="vault-editor-value"
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        disabled={busy}
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </FormField>
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {header}
      {kind === "contact" && !asking
        ? text("title", t`Label`, title, setTitle, { placeholder: t`Home` })
        : editing
          ? text("title", t`Name`, title, setTitle)
          : null}
      {kind === "login" ? (
        <>
          {siteField("https://www.example.com")}
          {initial?.replacedSite ? (
            <p className="-mt-2 break-all text-body-sm text-muted-foreground">
              {t`Replaces the login saved for ${initial.replacedSite}`}
            </p>
          ) : null}
          <LoginFieldsInput
            fields={login}
            fixedLabels={asking}
            displayLabels={initial?.loginLabels}
            disabled={busy}
            onChange={setLogin}
          />
          {asking ? null : (
            <>
              {otpShown
                ? text("otp", t`Authenticator key`, otp, setOtp, {
                    type: "password",
                    autoComplete: "new-password",
                  })
                : null}
              {keyUnreadable ? (
                <p className="-mt-2 text-label text-destructive">
                  <Trans>This authenticator key can't be read.</Trans>
                </p>
              ) : null}
              {alsoOnShown
                ? text("also-on", t`Also on`, alsoOn, setAlsoOn, {
                    placeholder: "https://login.example.com",
                  })
                : null}
              {otherSites === "invalid" ? (
                <p className="-mt-2 text-label text-destructive">
                  <Trans>Enter each site as an HTTPS address a login can be saved for.</Trans>
                </p>
              ) : otherSites === "too_many" ? (
                <p className="-mt-2 text-label text-destructive">{t`Up to ${limit} sites.`}</p>
              ) : null}
              {otpShown && alsoOnShown ? null : (
                <div className="flex gap-4">
                  {otpShown ? null : (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="px-0 text-muted-foreground"
                      onClick={() => setOtpShown(true)}
                    >
                      <Trans>Add an authenticator key</Trans>
                    </Button>
                  )}
                  {alsoOnShown ? null : (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="px-0 text-muted-foreground"
                      onClick={() => setAlsoOnShown(true)}
                    >
                      <Trans>Add other sites</Trans>
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      ) : null}
      {kind === "card" ? (
        <>
          <FormField id={id("number")} label={t`Card number`}>
            <div className="relative">
              <Input
                id={id("number")}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={groupedCardNumber(cardDigits)}
                onChange={(event) => setCardNumber(digitsOf(event.target.value, 19))}
                className="pe-24 font-mono tabular-nums"
              />
              {brand !== "Card" ? (
                <span
                  data-testid="vault-card-brand"
                  className="pointer-events-none absolute inset-y-0 end-2 my-auto h-fit rounded-full bg-accent px-2 py-0.5 text-label text-muted-foreground"
                >
                  {brand}
                </span>
              ) : null}
            </div>
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            {text(
              "expiry",
              t`Expiry`,
              expiry,
              (next) => {
                // MM/YY as typed; a pasted MM/YYYY keeps its four-digit year.
                const digits = digitsOf(next, 6);
                setExpiry(digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits);
              },
              { inputMode: "numeric", placeholder: "MM/YY" },
            )}
            <FormField id={id("cvc")} label={t`Security code`}>
              <Input
                id={id("cvc")}
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                disabled={busy}
                value={cvc}
                onChange={(event) => setCvc(digitsOf(event.target.value, 4))}
              />
            </FormField>
          </div>
          {text("card-name", t`Name on card`, cardName, setCardName)}
          {contacts?.length ? (
            <FormField id={id("billing")} label={t`Billing address`}>
              <NativeSelect
                id={id("billing")}
                className="w-full"
                disabled={busy}
                value={billing}
                onChange={(event) => setBilling(event.target.value)}
              >
                <NativeSelectOption value="">{t`None`}</NativeSelectOption>
                {contacts.map((saved) => (
                  <NativeSelectOption key={saved.name} value={saved.name}>
                    {saved.title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
          ) : null}
        </>
      ) : null}
      {kind === "contact" ? (
        <>
          {contactField("name", t`Full name`)}
          {contactField("line1", t`Address`)}
          {contactField("line2", t`Address line 2`)}
          {contactField("city", t`City`)}
          <div className="grid grid-cols-2 gap-3">
            {contactField("region", t`State or region`)}
            {contactField("postalCode", t`ZIP or postal code`)}
          </div>
          {contactField("country", t`Country`)}
          <div className="grid grid-cols-2 gap-3">
            {contactField("phone", t`Phone`)}
            {contactField("email", t`Email`)}
          </div>
        </>
      ) : null}
      {kind === "api_key" ? (
        <>
          {siteField("https://api.example.com")}
          <FormField id={id("auth")} label={t`Type`}>
            <NativeSelect
              id={id("auth")}
              data-testid="vault-editor-auth"
              className="w-full"
              disabled={busy || editing || asking}
              value={apiType}
              onChange={(event) => setApiType(event.target.value as ApiAuthType)}
            >
              <NativeSelectOption value="bearer">{t`Bearer token`}</NativeSelectOption>
              <NativeSelectOption value="header">{t`Custom header`}</NativeSelectOption>
              <NativeSelectOption value="basic">{t`Basic auth`}</NativeSelectOption>
            </NativeSelect>
          </FormField>
          {apiType === "header"
            ? text("header", t`Header name`, headerName, setHeaderName, {
                placeholder: "X-Api-Key",
                disabled: editing || asking,
              })
            : null}
          {apiType === "basic"
            ? text("username", t`Username`, basicUsername, setBasicUsername, {
                disabled: editing || asking,
              })
            : null}
          {protectedValue(t`Value`, editing ? "••••••••" : undefined)}
        </>
      ) : null}
      {kind === "variable" ? (
        <>
          <FormField id={id("variable")} label={t`Variable name`}>
            <Input
              id={id("variable")}
              data-testid="vault-editor-variable"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              disabled={busy || editing || asking}
              placeholder="DEPLOY_TOKEN"
              value={variable}
              onChange={(event) => setVariable(event.target.value)}
              className="font-mono"
              aria-invalid={reserved ? true : undefined}
            />
            {commandVariable ? (
              <span
                data-testid={reserved ? "vault-editor-variable-error" : "vault-editor-variable"}
                className={`text-label ${reserved ? "text-destructive" : "text-muted-foreground"}`}
              >
                {reserved
                  ? t`${commandVariable} is reserved and cannot be used as a command variable. Choose another name.`
                  : t`Available to shell commands as ${commandVariable}`}
              </span>
            ) : null}
          </FormField>
          {protectedValue(t`Value`, editing ? "••••••••" : undefined)}
        </>
      ) : null}
      {asking ? null : (
        <VaultItemAccess
          kind={kind}
          policy={policy}
          access={access}
          note={initial?.botsNote}
          disabled={busy}
          onChange={setPolicy}
          onAccessChange={setAccess}
        />
      )}
      {asking ? null : noteShown ? (
        text("note", t`When to use`, note, setNote, { maxLength: 200 })
      ) : (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="self-start px-0 text-muted-foreground"
          onClick={() => setNoteShown(true)}
        >
          <Trans>Add a note</Trans>
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-1 flex items-center gap-2">
        {asking && kind === "login" ? (
          <div className="flex items-center gap-2">
            <Switch
              id={id("remember")}
              size="sm"
              checked={remember}
              disabled={busy}
              onCheckedChange={setRemember}
            />
            <Label
              htmlFor={id("remember")}
              className="text-body-sm font-normal text-muted-foreground"
            >
              <Trans>Save to Vault</Trans>
            </Label>
          </div>
        ) : null}
        <span className="flex-1" />
        {onDismiss ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void dismiss()}>
            <Trans>Dismiss</Trans>
          </Button>
        ) : null}
        <Button type="submit" data-testid="vault-editor-save" disabled={!ready || busy}>
          {asking && kind === "login" && !remember ? (
            busy ? (
              <Trans>Sending…</Trans>
            ) : (
              <Trans>Continue</Trans>
            )
          ) : busy ? (
            <Trans>Saving…</Trans>
          ) : (
            <Trans>Save</Trans>
          )}
        </Button>
      </div>
    </form>
  );
}
