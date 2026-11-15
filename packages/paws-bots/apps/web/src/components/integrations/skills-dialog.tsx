import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, PluginMarketplaceEntry } from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import { installedPluginParts, matchesPluginQuery } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, LayoutTemplate, X } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { AgentSkills } from "../../pages/KnowledgeSection";
import type { PluginSelection } from "./plugin-marketplace";
import {
  PluginDetail,
  PluginLogo,
  PluginRow,
  pluginSelection,
  ROW_HOVER,
} from "./plugin-marketplace";

const NO_ENTRIES: PluginMarketplaceEntry[] = [];
const NO_SERVERS: never[] = [];
const NOT_ASSIGNED = new Set<string>();

function skillCount(install: CapabilityInstall) {
  const parsed = PluginPreviewSchema.safeParse(install.config);
  return parsed.success ? parsed.data.skills.length : 0;
}

/** Your skills in this space, the skills plugins added, and skill packs to browse. */
export function SkillsDialog({
  onClose,
  onOpenTemplates,
}: {
  onClose: () => void;
  onOpenTemplates?: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<PluginSelection | null>(null);
  const [importing, setImporting] = useState(false);
  const [gitSource, setGitSource] = useState("");
  const catalog = useQuery(
    queries.marketplace.catalog.queryOptions({ input: { query: "" }, staleTime: 60_000 }),
  );
  const installs = useQuery(queries.capabilities.list.queryOptions());
  const packs = (catalog.data?.entries ?? NO_ENTRIES).filter(
    (entry) => !entry.hasConnector && matchesPluginQuery(entry, query),
  );
  const pluginInstalls = (installs.data ?? []).filter((row) => row.kind === "plugin");
  const skillSets = pluginInstalls.filter(
    (row) => installedPluginParts(row.config).includes("skills") && skillCount(row) > 0,
  );
  const catalogEntries = catalog.data?.entries ?? NO_ENTRIES;
  function installedSelection(install: CapabilityInstall): PluginSelection {
    const entry = catalogEntries.find((row) => row.installedSource === install.source);
    return entry
      ? pluginSelection(entry)
      : { source: install.source, installedSource: install.source, name: install.name };
  }

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queries.capabilities.key() }),
      queryClient.invalidateQueries({ queryKey: queries.agentSkills.key() }),
    ]);
  }

  function back(onBack: () => void) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="-ms-2 text-muted-foreground"
        aria-label={t`Back`}
        onClick={onBack}
      >
        <ChevronLeft />
      </Button>
    );
  }

  function content() {
    if (selection)
      return (
        <PluginDetail
          key={selection.installedSource}
          selection={selection}
          installs={pluginInstalls}
          servers={NO_SERVERS}
          assigned={NOT_ASSIGNED}
          skillsOnly
          onBack={() => setSelection(null)}
          onChanged={refresh}
        />
      );
    if (importing)
      return (
        <div data-testid="skills-git-import" className="max-w-xl space-y-6">
          <div className="flex items-center gap-2">
            {back(() => setImporting(false))}
            <SectionHeading as="h2" variant="heading">
              <Trans>From GitHub</Trans>
            </SectionHeading>
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const source = gitSource.trim().replace(/\/$/, "");
              if (!source) return;
              setSelection({
                source,
                installedSource: source,
                name: source.split("/").pop() ?? source,
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="skills-git-url">
                <Trans>Plugin GitHub URL</Trans>
              </FieldLabel>
              <Input
                id="skills-git-url"
                value={gitSource}
                onChange={(event) => setGitSource(event.target.value)}
                placeholder="https://github.com/owner/plugin"
                maxLength={2048}
                autoFocus
              />
            </Field>
            <Button type="submit" disabled={!gitSource.trim()}>
              <Trans>Preview</Trans>
            </Button>
          </form>
        </div>
      );
    return (
      <div className="space-y-8">
        <section data-testid="your-skills">
          <h3 className="mb-2 px-2.5 text-body font-medium text-muted-foreground">
            <Trans>Your skills</Trans>
          </h3>
          <div className="px-2.5">
            <AgentSkills />
          </div>
        </section>
        {skillSets.length ? (
          <section data-testid="plugin-skill-sets">
            <h3 className="mb-2 px-2.5 text-body font-medium text-muted-foreground">
              <Trans>Plugins</Trans>
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {skillSets.map((install) => {
                const set = installedSelection(install);
                return (
                  <button
                    key={install.id}
                    type="button"
                    data-testid="plugin-skill-set"
                    onClick={() => setSelection(set)}
                    className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-start focus-visible:outline-none ${ROW_HOVER}`}
                  >
                    <PluginLogo name={set.name} logo={set.logo} site={set.site} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-lg font-medium">{set.name}</span>
                      <span className="block truncate text-body-sm text-muted-foreground">
                        <Plural value={skillCount(install)} one="# skill" other="# skills" />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}
        <section data-testid="skill-packs-section">
          <h3 className="mb-2 px-2.5 text-body font-medium text-muted-foreground">
            <Trans>Browse</Trans>
          </h3>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t`Search skills`}
            placeholder={t`Search skills`}
            maxLength={200}
            className="mb-5 h-11 rounded-xl"
          />
          {catalog.isPending ? (
            <div className="grid place-items-center py-10">
              <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
            </div>
          ) : null}
          {catalog.error || catalog.data?.unavailableRegistries.length ? (
            <div
              role="alert"
              className="mb-4 flex items-center gap-3 text-body text-muted-foreground"
            >
              <Trans>Some plugins could not be loaded.</Trans>
              <Button variant="outline" size="sm" onClick={() => void catalog.refetch()}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : null}
          <div data-testid="skill-packs" className="grid grid-cols-2 gap-2">
            {packs.map((entry) => {
              const pack = pluginSelection(entry);
              return (
                <PluginRow
                  key={entry.id}
                  name={entry.displayName}
                  description={entry.description}
                  logo={entry.logo}
                  site={pack.site}
                  installed={pluginInstalls.some((row) => row.source === entry.installedSource)}
                  onOpen={() => setSelection(pack)}
                />
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} size="xl" className="bg-card">
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Skills</Trans>
          </DialogTitle>
          <div className="flex items-center gap-2">
            {!selection && !importing && onOpenTemplates ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="open-bot-templates"
                onClick={onOpenTemplates}
              >
                <LayoutTemplate />
                <Trans>Templates</Trans>
              </Button>
            ) : null}
            {!selection && !importing ? (
              <Button variant="ghost" size="sm" onClick={() => setImporting(true)}>
                <Trans>From GitHub</Trans>
              </Button>
            ) : null}
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close skills`} />}
            >
              <X />
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-8">{content()}</div>
      </DialogContent>
    </Dialog>
  );
}
