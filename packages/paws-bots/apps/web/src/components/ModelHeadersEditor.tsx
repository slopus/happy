import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelHeaderRow } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { X } from "lucide-react";

export function ModelHeadersEditor({
  rows,
  savedNames = [],
  onChange,
  disabled,
}: {
  rows: ModelHeaderRow[] | null;
  savedNames?: string[];
  onChange: (rows: ModelHeaderRow[]) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const visible = rows ?? savedNames.map((name) => ({ name, value: "" }));
  return (
    <fieldset className="mt-4 space-y-2" disabled={disabled}>
      <legend className="text-body">
        <Trans>Headers</Trans>
      </legend>
      {visible.map((row, index) => (
        <div className="flex items-center gap-2" key={index}>
          <Input
            aria-label={t`Header name`}
            value={row.name}
            autoComplete="off"
            maxLength={256}
            onChange={(event) =>
              onChange(
                visible.map((entry, i) =>
                  i === index ? { ...entry, name: event.target.value } : entry,
                ),
              )
            }
          />
          <Input
            aria-label={t`Header value`}
            type="password"
            placeholder={savedNames.includes(row.name) ? "••••••••" : undefined}
            value={row.value}
            autoComplete="new-password"
            maxLength={1024}
            onChange={(event) =>
              onChange(
                visible.map((entry, i) =>
                  i === index ? { ...entry, value: event.target.value } : entry,
                ),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t`Remove header`}
            onClick={() => onChange(visible.filter((_, i) => i !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={visible.length >= 8}
        onClick={() => onChange([...visible, { name: "", value: "" }])}
      >
        <Trans>Add header</Trans>
      </Button>
    </fieldset>
  );
}
