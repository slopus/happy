import { Trans, useLingui } from "@lingui/react/macro";
import type { LoginFieldInput } from "@rakazo/contracts";
import { LOGIN_FIELD_LIMIT } from "@rakazo/contracts";
import { Button, Input, Label, Toggle } from "@rakazo/ui-web";
import { Lock, LockOpen, Plus, X } from "lucide-react";
import { useId } from "react";

/**
 * Whether a login value is hidden: a hidden one stays masked and is typed only into password
 * fields. An icon toggle, named for what it turns on, beside the field it belongs to.
 */
function HiddenToggle({
  label,
  hidden,
  disabled,
  onChange,
}: {
  label: string;
  hidden: boolean;
  disabled?: boolean;
  onChange: (hidden: boolean) => void;
}) {
  const { t } = useLingui();
  const describedBy = useId();
  return (
    <>
      <Toggle
        size="sm"
        pressed={hidden}
        disabled={disabled}
        aria-label={t`Hidden`}
        aria-describedby={describedBy}
        data-testid="login-field-hidden"
        className="shrink-0 text-muted-foreground"
        onPressedChange={onChange}
      >
        {hidden ? <Lock /> : <LockOpen />}
      </Toggle>
      <span id={describedBy} className="sr-only">
        {label}
      </span>
    </>
  );
}

function ValueInput({
  label,
  field,
  disabled,
  onChange,
}: {
  label: string;
  field: Pick<LoginFieldInput, "value" | "hidden">;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      className="w-full"
      aria-label={label}
      type={field.hidden ? "password" : "text"}
      // "off" is ignored for username-like fields; this stops browsers saving the login.
      autoComplete="new-password"
      spellCheck={false}
      disabled={disabled}
      value={field.value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * A login's fields. With `fixedLabels` (a chat card asks for exactly these) only the values and
 * whether each is hidden can change; otherwise fields can be renamed, added and removed.
 */
export function LoginFieldsInput({
  fields,
  fixedLabels,
  displayLabels,
  disabled,
  onChange,
}: {
  fields: LoginFieldInput[];
  fixedLabels?: boolean;
  /** What fixed fields are called on screen, when that differs from the label they answer with. */
  displayLabels?: readonly string[];
  disabled?: boolean;
  onChange: (fields: LoginFieldInput[]) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const update = (index: number, change: Partial<LoginFieldInput>) =>
    onChange(fields.map((field, at) => (at === index ? { ...field, ...change } : field)));
  if (fixedLabels)
    return (
      <div className="flex flex-col gap-3" data-testid="login-fields">
        {fields.map((field, index) => (
          <div key={field.label} className="flex flex-col gap-1.5" data-testid="login-field">
            <Label htmlFor={`${ids}-${index}`} className="text-body-sm text-muted-foreground">
              {displayLabels?.[index] ?? field.label}
            </Label>
            <div className="flex items-center gap-1.5">
              <Input
                id={`${ids}-${index}`}
                className="w-full"
                type={field.hidden ? "password" : "text"}
                autoComplete="new-password"
                spellCheck={false}
                disabled={disabled}
                value={field.value}
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <HiddenToggle
                label={displayLabels?.[index] ?? field.label}
                hidden={field.hidden}
                disabled={disabled}
                onChange={(hidden) => update(index, { hidden })}
              />
            </div>
          </div>
        ))}
      </div>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="login-fields">
      {fields.map((field, index) => {
        const label = field.label.trim() || t`Value`;
        return (
          <div key={index} className="flex items-center gap-1.5" data-testid="login-field">
            <Input
              aria-label={t`Label`}
              placeholder={t`Label`}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              value={field.label}
              onChange={(event) => update(index, { label: event.target.value })}
              className="w-32 shrink-0"
            />
            <ValueInput
              label={label}
              field={field}
              disabled={disabled}
              onChange={(value) => update(index, { value })}
            />
            <HiddenToggle
              label={label}
              hidden={field.hidden}
              disabled={disabled}
              onChange={(hidden) => update(index, { hidden })}
            />
            {fields.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t`Remove`}
                className="shrink-0 text-muted-foreground"
                disabled={disabled}
                onClick={() => onChange(fields.filter((_, at) => at !== index))}
              >
                <X />
              </Button>
            ) : null}
          </div>
        );
      })}
      {fields.length < LOGIN_FIELD_LIMIT ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          disabled={disabled}
          onClick={() => onChange([...fields, { label: "", value: "", hidden: true }])}
        >
          <Plus />
          <Trans>Add field</Trans>
        </Button>
      ) : null}
    </div>
  );
}
