import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useLinkFavicon } from "@rakazo/chat-ui/web";
import type {
  CapabilityInstall,
  McpServer,
  PluginMarketplaceEntry,
  PluginPart,
  PluginPreview,
} from "@rakazo/contracts";
import { mcpServerConnection, mcpServerNeedsSignIn, PluginPreviewSchema } from "@rakazo/contracts";
import { installedPluginParts } from "@rakazo/core";
import { Button, Spinner } from "@rakazo/ui-web";
import { ArrowUpRight, Check, ChevronLeft, FileText, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import type { ErrorDetails } from "../../lib/user-error";
import { errorDetails } from "../../lib/user-error";
import { ErrorNotice } from "../ErrorNotice";
import { AvailabilityControl, reachesOtherSpaces, useOwnSpaces } from "./space-availability";

export type PluginSelection = {
  source: string;
  installedSource: string;
  name: string;
  description?: string;
  logo?: string | null;
  site?: string | null;
};

export function pluginSelection(entry: PluginMarketplaceEntry): PluginSelection {
  return {
    source: entry.source,
    installedSource: entry.installedSource,
    name: entry.displayName,
    description: entry.description,
    logo: entry.logo,
    site: pluginSite(entry),
  };
}

/** GitHub homepages would give every plugin the same mark, so they never stand in for a site. */
function pluginSite(entry: Pick<PluginMarketplaceEntry, "homepage" | "domains">): string | null {
  const domain = entry.domains[0]?.replace(/^https?:\/\//, "");
  if (domain) return `https://${domain}`;
  try {
    return entry.homepage && !new URL(entry.homepage).hostname.endsWith("github.com")
      ? entry.homepage
      : null;
  } catch {
    return null;
  }
}

export function PluginLogo({
  name,
  logo,
  site,
  large = false,
}: {
  name: string;
  logo?: string | null;
  site?: string | null;
  large?: boolean;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const useLogo = Boolean(logo) && !logoFailed;
  const favicon = useLinkFavicon(useLogo ? "" : (site ?? ""));
  const src = useLogo ? logo : favicon.icon;
  const box = large ? "h-14 w-14 rounded-2xl text-heading2" : "h-10 w-10 rounded-xl text-body";
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => (useLogo ? setLogoFailed(true) : favicon.unusable())}
      className={`${box} shrink-0 border border-border/60 bg-favicon-plate object-contain p-1.5`}
    />
  ) : (
    <div
      className={`${box} grid shrink-0 place-items-center border border-border/60 bg-favicon-plate font-semibold text-foreground`}
    >
      {name[0]?.toUpperCase()}
    </div>
  );
}

/** A list row: icon, text and trailing actions on one line. */
export const ROW_SHELL = "flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2";

/** The row's main button, which fills the row up to its trailing actions. */
export const ROW_BUTTON =
  "flex min-w-0 flex-1 items-center gap-3 text-start focus-visible:outline-none";

/** The whole row highlights, including for keyboard focus on its main button. */
export const ROW_HOVER = "hover:bg-accent/60 has-[button:focus-visible]:bg-accent/60";

export function PluginRow({
  name,
  description,
  logo,
  site,
  installed,
  onOpen,
}: {
  name: string;
  description: string;
  logo?: string | null;
  site?: string | null;
  installed: boolean;
  onOpen: () => void;
}) {
  return (
    <div data-testid="plugin-row" className={`${ROW_SHELL} ${ROW_HOVER}`}>
      <button type="button" onClick={onOpen} className={ROW_BUTTON}>
        <PluginLogo name={name} logo={logo} site={site} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium text-foreground">{name}</span>
          {description ? (
            <span className="block truncate text-body-sm text-muted-foreground">{description}</span>
          ) : null}
        </span>
      </button>
      <Button type="button" variant="secondary" size="sm" onClick={onOpen}>
        {installed ? <Trans>Added</Trans> : <Trans>Add</Trans>}
      </Button>
    </div>
  );
}

function sourceHref(source: string, sha: string | undefined) {
  const [repo, subdir] = source.split("#");
  return subdir ? `${repo}/tree/${sha ?? "HEAD"}/${subdir}` : repo;
}

const SKILLS_SHOWN = 5;

/** The managed app a plugin page connects instead of the plugin's own connector. */
export type ManagedAppLink = {
  name: string;
  logo: string | null;
  connected: boolean;
  connecting: boolean;
  onConnect: () => void;
  onManage: () => void;
};

export function PluginDetail({
  selection,
  installs,
  servers: allServers,
  assigned,
  activeBotId,
  managed: managedApp,
  skillsOnly = false,
  onBack,
  onChanged,
}: {
  selection: PluginSelection;
  installs: CapabilityInstall[];
  servers: McpServer[];
  assigned: Set<string>;
  activeBotId?: string;
  managed?: ManagedAppLink;
  /** Opened from Skills: only the plugin's skills are added here; its connector belongs to Integrations. */
  skillsOnly?: boolean;
  onBack: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [recipe, setRecipe] = useState<{ name: string; content: string | null } | null>(null);
  const [allSkills, setAllSkills] = useState(false);
  const [noAuth, setNoAuth] = useState(new Set<string>());
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  const spaceCount = useOwnSpaces().length;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A pasted URL can differ from the normalized source the install is saved under.
  const install = installs.find(
    (row) =>
      row.kind === "plugin" &&
      (row.source === selection.installedSource || row.source === preview?.installedSource),
  );
  const parts = install ? installedPluginParts(install.config) : [];
  const servers =
    install && parts.includes("connector")
      ? allServers.filter((server) => server.installId === install.id)
      : [];
  const parsed = install ? PluginPreviewSchema.safeParse(install.config) : null;
  const detail = parsed?.success ? parsed.data : preview;
  const installed = Boolean(install);

  useEffect(() => {
    if (installed) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    setPreviewLoading(true);
    rpc.capabilities
      .pluginPreview({ source: selection.source })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(errorDetails(err, t`Could not preview plugin`));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection.source, installed, attempt]);

  async function run(key: string, action: () => Promise<unknown>, failure: string) {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (live.current) setError(errorDetails(err, failure));
    } finally {
      if (live.current) setPending(null);
    }
  }

  /** The first part installs the plugin; later changes keep its pinned version. */
  const setParts = (key: string, next: PluginPart[], failure: string) =>
    run(
      key,
      async () => {
        if (install) await rpc.capabilities.pluginParts({ id: install.id, parts: next });
        else if (preview)
          await rpc.capabilities.install({
            kind: "plugin",
            name: preview.name,
            source: preview.pinnedSource ?? selection.source,
            pluginDigest: preview.digest,
            config: {},
            pluginParts: next,
          });
        setConfirmRemove(false);
        await onChanged();
      },
      failure,
    );
  const toggle = (part: PluginPart, on: boolean) =>
    on
      ? [...parts.filter((value) => value !== part), part]
      : parts.filter((value) => value !== part);

  const signIn = (server: McpServer) =>
    run(
      server.id,
      async () => {
        const result = await connectMcpOauth(server.id);
        if (!live.current) return;
        if (result === "authorization_not_requested")
          setNoAuth((current) => new Set([...current, server.id]));
        if (result === "cancelled") setError(errorDetails(t`Sign-in cancelled. Try again.`));
        await onChanged();
      },
      t`Could not sign in`,
    );

  const enable = (server: McpServer) =>
    activeBotId &&
    run(
      server.id,
      async () => {
        await rpc.mcp.assignments.approve({ botId: activeBotId, serverId: server.id });
        await onChanged();
      },
      t`Could not enable tools`,
    );

  // A plugin connector already installed stays manageable here until it is removed.
  const managed = parts.includes("connector") ? undefined : managedApp;
  // Installed plugin skills are read-only, so their saved instructions open in place.
  async function toggleRecipe(name: string) {
    if (recipe?.name === name) return setRecipe(null);
    setRecipe({ name, content: null });
    try {
      const entry = (await rpc.agentSkills.list()).find(
        (row) => row.source === "plugin" && row.name.toLowerCase() === name.toLowerCase(),
      );
      if (!entry) throw new Error(t`Could not load skill`);
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      if (live.current)
        setRecipe((open) => (open?.name === name ? { name, content: skill.content } : open));
    } catch (err) {
      if (live.current) {
        setRecipe(null);
        setError(errorDetails(err, t`Could not load skill`));
      }
    }
  }

  // An ignored manifest field loses nothing, so it isn't reported. A skill left out for repeating
  // a built-in one says why, since the user still has that skill.
  const notAdded = [
    ...(detail?.skipped ?? [])
      .filter((entry) => entry.kind !== "unsupported_field")
      .map((entry) => entry.name),
    ...(detail?.builtinNames ?? []).map((name) => t`${name} (same name as a built-in skill)`),
  ];
  const prefix = `${detail?.name ?? ""}: `;
  const skills = detail?.skills ?? [];
  const shownSkills = allSkills ? skills : skills.slice(0, SKILLS_SHOWN);
  const connectorCount = detail?.mcpServers.length ?? 0;
  // Without a connector there is nothing to connect, so the page adds the skills instead.
  const skillPack = skillsOnly || (!managed && !connectorCount && Boolean(detail));
  const headerPart: PluginPart = skillPack ? "skills" : "connector";
  const headerOn = parts.includes(headerPart);
  const skillsOn = parts.includes("skills");
  const busy = Boolean(pending);
  const everywhere = reachesOtherSpaces(install?.availability, spaceCount);
  const ready = Boolean(detail) && (Boolean(install) || Boolean(preview));

  function headerAction() {
    if (managed)
      return managed.connected ? (
        <Button variant="secondary" disabled={busy} onClick={managed.onManage}>
          <Trans>Added</Trans>
        </Button>
      ) : (
        <Button
          size="lg"
          className="px-5"
          disabled={busy || managed.connecting}
          onClick={managed.onConnect}
        >
          {managed.connecting ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
        </Button>
      );
    if (headerOn)
      return confirmRemove ? (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void setParts("header", toggle(headerPart, false), t`Could not remove plugin`)
            }
          >
            {pending === "header" ? (
              <Trans>Removing…</Trans>
            ) : everywhere ? (
              <Trans>Remove from every space?</Trans>
            ) : (
              <Trans>Confirm removal</Trans>
            )}
          </Button>
        </>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>
          <Trans>Remove</Trans>
        </Button>
      );
    return (
      <Button
        size="lg"
        className="px-5"
        disabled={busy || !ready}
        onClick={() =>
          void setParts("header", toggle(headerPart, true), t`Could not install plugin`)
        }
      >
        {pending === "header" ? (
          skillPack ? (
            <Trans>Adding…</Trans>
          ) : (
            <Trans>Connecting…</Trans>
          )
        ) : skillPack ? (
          <Trans>Add</Trans>
        ) : (
          <Trans>Connect</Trans>
        )}
      </Button>
    );
  }

  return (
    <div data-testid="plugin-detail" className="space-y-7">
      <div className="flex items-start gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-3.5 -ms-2 text-muted-foreground"
          aria-label={t`Back`}
          disabled={busy}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <PluginLogo
          name={selection.name}
          logo={managed?.logo ?? selection.logo}
          site={selection.site}
          large
        />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-heading2 font-semibold text-foreground">
            {managed?.name ?? selection.name}
          </h2>
          <a
            href={sourceHref(selection.installedSource, detail?.resolvedSha)}
            target="_blank"
            rel="noreferrer"
            title={detail ? `${selection.installedSource}@${detail.resolvedSha}` : undefined}
            className="inline-flex items-center gap-1 text-body text-muted-foreground hover:text-foreground"
          >
            <Trans>View source</Trans>
            <ArrowUpRight size={14} />
          </a>
        </div>
        <div className="flex shrink-0 gap-2 pt-2">{headerAction()}</div>
      </div>

      {detail?.description || selection.description ? (
        <p className="text-body-lg leading-6 text-muted-foreground">
          {detail?.description || selection.description}
        </p>
      ) : null}

      {install ? (
        <AvailabilityControl
          kind="install"
          id={install.id}
          availability={install.availability}
          onChanged={onChanged}
        />
      ) : null}

      {error ? (
        <ErrorNotice error={error}>
          {!installed && !preview && !previewLoading ? (
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          ) : null}
        </ErrorNotice>
      ) : null}

      {previewLoading ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : null}

      {!skillsOnly && (managed || connectorCount) ? (
        <section>
          <h3 className="mb-2 flex gap-2 px-1 text-body font-medium text-foreground">
            <Trans>Apps</Trans>
            <span className="text-muted-foreground">{managed ? 1 : connectorCount}</span>
          </h3>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {managed ? (
              <li className="flex items-center gap-3 px-4 py-3">
                <Plug size={16} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-lg font-medium">{managed.name}</span>
                  <span className="block truncate text-body-sm text-muted-foreground">
                    <Trans>Connector</Trans>
                  </span>
                </span>
                {managed.connected ? (
                  <Check role="img" aria-label={t`Connected`} className="size-4 text-success" />
                ) : null}
              </li>
            ) : servers.length ? (
              servers.map((server) => (
                <li
                  key={server.id}
                  aria-label={server.name}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <Plug size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">
                      {server.name.startsWith(prefix)
                        ? server.name.slice(prefix.length)
                        : server.name}
                    </span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {server.endpoint}
                    </span>
                  </span>
                  {mcpServerConnection(server) === "connected" ? (
                    <Check role="img" aria-label={t`Connected`} className="size-4 text-success" />
                  ) : noAuth.has(server.id) || !mcpServerNeedsSignIn(server) ? null : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void signIn(server)}
                    >
                      {pending === server.id ? (
                        <Trans>Connecting…</Trans>
                      ) : server.oauthStatus === "reconnect" ? (
                        <Trans>Reconnect</Trans>
                      ) : (
                        <Trans>Sign in</Trans>
                      )}
                    </Button>
                  )}
                  {activeBotId ? (
                    assigned.has(server.id) ? (
                      <span className="text-body-sm text-muted-foreground">
                        <Trans>In this bot</Trans>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void enable(server)}
                      >
                        <Trans>Use in this bot</Trans>
                      </Button>
                    )
                  ) : null}
                </li>
              ))
            ) : (
              detail?.mcpServers.map((server) => (
                <li key={server.name} className="flex items-center gap-3 px-4 py-3">
                  <Plug size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{server.name}</span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {server.endpoint}
                    </span>
                  </span>
                </li>
              ))
            )}
          </ul>
        </section>
      ) : null}

      {skills.length ? (
        <section data-testid="plugin-skills">
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <h3 className="flex gap-2 text-body font-medium text-foreground">
              <Trans>Skills</Trans>
              <span className="text-muted-foreground">{skills.length}</span>
            </h3>
            {skillPack ? null : (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !ready}
                onClick={() =>
                  void setParts(
                    "skills",
                    toggle("skills", !skillsOn),
                    skillsOn ? t`Could not remove skills` : t`Could not add skills`,
                  )
                }
              >
                {pending === "skills" ? (
                  skillsOn ? (
                    <Trans>Removing…</Trans>
                  ) : (
                    <Trans>Adding…</Trans>
                  )
                ) : skillsOn ? (
                  <Trans>Remove skills</Trans>
                ) : (
                  <Trans>Add skills</Trans>
                )}
              </Button>
            )}
          </div>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {shownSkills.map((skill) => {
              const row = (
                <>
                  <FileText size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{skill.name}</span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {skill.description}
                    </span>
                  </span>
                  {skill.files?.length ? (
                    <span
                      className="shrink-0 text-body-sm text-muted-foreground"
                      title={skill.files.join("\n")}
                    >
                      <Plural value={skill.files.length} one="# file" other="# files" />
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={skill.name}>
                  {skillsOn ? (
                    <button
                      type="button"
                      aria-expanded={recipe?.name === skill.name}
                      className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-accent/60"
                      onClick={() => void toggleRecipe(skill.name)}
                    >
                      {row}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-3">{row}</div>
                  )}
                  {recipe?.name === skill.name ? (
                    <pre
                      data-testid="plugin-skill-recipe"
                      className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border/60 px-4 py-3 font-mono text-body-sm text-foreground"
                      dir="auto"
                    >
                      {recipe.content ?? <Spinner className="size-4 text-muted-foreground" />}
                    </pre>
                  ) : null}
                </li>
              );
            })}
            {skills.length > shownSkills.length ? (
              <li className="flex justify-end px-2 py-1.5">
                <Button variant="text" size="sm" onClick={() => setAllSkills(true)}>
                  <Plural value={skills.length - shownSkills.length} one="# more" other="# more" />
                </Button>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {notAdded.length ? (
        <p className="px-1 text-body-sm text-muted-foreground">
          <Trans>Not added: {notAdded.join(", ")}</Trans>
        </p>
      ) : null}
    </div>
  );
}
