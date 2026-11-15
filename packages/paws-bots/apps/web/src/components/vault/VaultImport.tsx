import { Trans, useLingui } from "@lingui/react/macro";
import type {
  BotSecretMetadata,
  VaultCsv,
  VaultImportResult,
  VaultImportRow,
} from "@rakazo/contracts";
import { newVaultImportRows, vaultImportCounts, vaultImportProblems } from "@rakazo/contracts";
import { vaultImportProblemLines, vaultImportText } from "@rakazo/i18n/vault";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { VaultPageHeader } from "./VaultPageHeader";

/** The review of a CSV export read on this device, then what the import saved. */
export function VaultImportPage({
  csv,
  saved,
  onImport,
  failureText,
  onBack,
}: {
  csv: VaultCsv;
  saved: readonly BotSecretMetadata[];
  onImport: (rows: VaultImportRow[]) => Promise<VaultImportResult>;
  failureText: (error: unknown) => string;
  onBack: () => void;
}) {
  const { t } = useLingui();
  // Planned against the list as it is, and kept as sent: the list then refreshes with the
  // imported logins. After a failure it plans again, as some may have been saved.
  const [sent, setSent] = useState<ReturnType<typeof newVaultImportRows>>();
  const plan = sent ?? ("rows" in csv ? newVaultImportRows(csv.rows, saved, csv.lines) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VaultImportResult>();
  const { labels, botsNote, fileProblems } = vaultImportText();

  const problems = vaultImportProblemLines(
    "rows" in csv && plan ? vaultImportProblems(csv.problems, plan, result) : [],
  );

  async function save() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setSent(plan);
    try {
      setResult(await onImport(plan.rows));
    } catch (err) {
      setSent(undefined);
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="vault-import-page" className="space-y-4">
      <VaultPageHeader title={t`Import CSV`} onBack={() => !busy && onBack()} />
      {"error" in csv ? (
        <p className="text-body-sm text-destructive">{fileProblems[csv.error]}</p>
      ) : plan ? (
        <ul className="overflow-hidden rounded-xl bg-muted/50">
          {vaultImportCounts(csv.skipped, plan, result).map(([kind, count]) => (
            <li
              key={kind}
              data-testid="vault-import-count"
              className="flex justify-between border-t border-border px-3.5 py-2.5 text-body first:border-t-0"
            >
              <span>{labels[kind]}</span>
              <span className="text-muted-foreground tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {problems.length ? (
        <ul
          data-testid="vault-import-problems"
          className="space-y-1 text-body-sm text-muted-foreground"
        >
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {result ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Delete the exported file now. It holds your passwords unencrypted.</Trans>
        </p>
      ) : plan?.rows.length ? (
        <p className="text-body-sm text-muted-foreground">{botsNote}</p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-line text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        {result || !plan ? (
          <Button size="sm" onClick={onBack}>
            <Trans>Done</Trans>
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !plan.rows.length} onClick={save}>
            <Trans>Import</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}
