import { Trans, useLingui } from "@lingui/react/macro";
import type { IntegrationCatalogResult, IntegrationCatalogSurface } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { ViewTitle } from "./parts";

export type DomainSearchState = ReturnType<typeof useDomainSearch>;

/** A search of the optional integration catalog by domain; its results stay while the overlay is open. */
export function useDomainSearch() {
  const { t } = useLingui();
  const [catalogFeedQuery, setCatalogFeedQuery] = useState("");
  const [catalogFeedResults, setCatalogFeedResults] = useState<IntegrationCatalogResult[]>([]);
  const [catalogFeedError, setCatalogFeedError] = useState<string | null>(null);
  const [catalogFeedPending, setCatalogFeedPending] = useState(false);
  const [catalogFeedSearched, setCatalogFeedSearched] = useState(false);

  async function search() {
    setCatalogFeedError(null);
    setCatalogFeedPending(true);
    setCatalogFeedSearched(false);
    setCatalogFeedResults([]);
    try {
      const response = await rpc.capabilities.catalogSearch({
        query: catalogFeedQuery,
      });
      setCatalogFeedResults(response.results);
      setCatalogFeedSearched(true);
    } catch (err) {
      setCatalogFeedError(errorText(err, t`Could not search catalog`));
    } finally {
      setCatalogFeedPending(false);
    }
  }

  return {
    catalogFeedQuery,
    setCatalogFeedQuery,
    catalogFeedResults,
    setCatalogFeedResults,
    catalogFeedError,
    setCatalogFeedError,
    catalogFeedPending,
    catalogFeedSearched,
    setCatalogFeedSearched,
    search,
  };
}

export function DomainSearch({
  state,
  onBack,
  onPick,
}: {
  state: DomainSearchState;
  onBack: () => void;
  onPick: (result: IntegrationCatalogResult, surface: IntegrationCatalogSurface) => void;
}) {
  const { t } = useLingui();
  const {
    catalogFeedQuery,
    setCatalogFeedQuery,
    catalogFeedResults,
    setCatalogFeedResults,
    catalogFeedError,
    setCatalogFeedError,
    catalogFeedPending,
    catalogFeedSearched,
    setCatalogFeedSearched,
    search,
  } = state;
  return (
    <div data-testid="integrations-catalog-feed" className="max-w-2xl space-y-6">
      <ViewTitle title={<Trans>Search by domain</Trans>} onBack={onBack} />
      <div className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <Input
            value={catalogFeedQuery}
            disabled={catalogFeedPending}
            onChange={(event) => {
              setCatalogFeedQuery(event.target.value);
              setCatalogFeedResults([]);
              setCatalogFeedError(null);
              setCatalogFeedSearched(false);
            }}
            placeholder="github.com"
            aria-label={t`Integration domain`}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!catalogFeedQuery.trim() || catalogFeedPending}
          >
            {catalogFeedPending ? <Trans>Searching…</Trans> : <Trans>Search</Trans>}
          </Button>
        </form>
        {catalogFeedError ? <p className="text-body text-destructive">{catalogFeedError}</p> : null}
        {catalogFeedSearched && !catalogFeedPending && catalogFeedResults.length === 0 ? (
          <p className="text-body text-muted-foreground">
            <Trans>No results</Trans>
          </p>
        ) : null}
        {catalogFeedResults.map((result) => (
          <div
            key={`${result.domain}:${result.name}:${result.pageUrl ?? ""}`}
            className="rounded-xl border border-border/70 p-3"
          >
            <div className="font-medium text-foreground">
              {result.pageUrl ? (
                <a
                  href={result.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {result.name}
                </a>
              ) : (
                result.name
              )}
            </div>
            <div className="text-label text-muted-foreground">{result.domain}</div>
            {result.description ? (
              <p className="mt-2 text-body text-muted-foreground">{result.description}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {result.surfaces.map((surface) => {
                const canAdd =
                  Boolean(surface.source) && (surface.kind === "mcp" || surface.kind === "openapi");
                return (
                  <Button
                    key={`${result.domain}:${surface.slug}`}
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!canAdd}
                    title={canAdd ? undefined : t`Manual setup required`}
                    onClick={() => onPick(result, surface)}
                  >
                    <span>{surface.kind.toUpperCase()}</span>
                    <span>{canAdd ? t`Add` : t`Manual`}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
