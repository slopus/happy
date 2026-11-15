import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import { ViewTitle } from "./parts";

/** Previewing a plugin from its GitHub URL; the URL stays while the overlay is open. */
export function GithubImport({
  value,
  onChange,
  onBack,
  onPreview,
}: {
  value: string;
  onChange: (value: string) => void;
  onBack: () => void;
  onPreview: (selection: PluginSelection) => void;
}) {
  return (
    <div data-testid="plugin-git-import" className="max-w-xl space-y-6">
      <ViewTitle title={<Trans>From GitHub</Trans>} onBack={onBack} />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const source = value.trim();
          if (!source) return;
          onPreview({
            source,
            installedSource: source.replace(/\/$/, ""),
            name: source.replace(/\/$/, "").split("/").pop() ?? source,
          });
        }}
      >
        <Field>
          <FieldLabel htmlFor="plugin-git-url">
            <Trans>Plugin GitHub URL</Trans>
          </FieldLabel>
          <Input
            id="plugin-git-url"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="https://github.com/owner/plugin"
            maxLength={2048}
            autoFocus
          />
        </Field>
        <Button type="submit" disabled={!value.trim()}>
          <Trans>Preview</Trans>
        </Button>
      </form>
    </div>
  );
}
