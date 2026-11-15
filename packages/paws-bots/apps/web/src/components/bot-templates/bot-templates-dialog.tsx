import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Bot, BotTemplateListing, ConnectionCatalogItem } from "@rakazo/contracts";
import { isBotTemplateChanged } from "@rakazo/contracts";
import { botTemplateApps, formatCron } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  Bot as BotIcon,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  GitPullRequest,
  Inbox,
  LayoutTemplate,
  ScrollText,
  Sun,
  Telescope,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cronLabels } from "../../lib/cron";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import type { ErrorDetails } from "../../lib/user-error";
import { errorDetails } from "../../lib/user-error";
import { ErrorNotice } from "../ErrorNotice";
import { PluginLogo, ROW_HOVER } from "../integrations/plugin-marketplace";
import { useBotTemplateCopy } from "./bot-template-copy";

const ICONS: Record<string, LucideIcon> = {
  "morning-briefing": Sun,
  "inbox-triage": Inbox,
  "pr-reviewer": GitPullRequest,
  "topic-watch": Telescope,
};

function TemplateIcon({ id, large = false }: { id: string; large?: boolean }) {
  const Icon = ICONS[id] ?? LayoutTemplate;
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center border border-border/60 bg-muted text-foreground ${
        large ? "h-14 w-14 rounded-2xl" : "h-10 w-10 rounded-xl"
      }`}
    >
      <Icon size={large ? 24 : 18} />
    </span>
  );
}

function Sample({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background px-4 py-3 text-body">
      <ChatMarkdown>{text}</ChatMarkdown>
    </div>
  );
}

/** Ready-made bots. Creating one opens it; its routines stay paused until the user turns them on. */
export function BotTemplatesDialog({
  onClose,
  onOpenBot,
}: {
  onClose: () => void;
  onOpenBot: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const copy = useBotTemplateCopy();
  // Read afresh each time it opens: a template's bot may have been made or deleted since.
  const templates = useQuery({ ...queries.bots.templates.queryOptions(), staleTime: 0 });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = templates.data?.find((template) => template.id === openId);

  function content() {
    if (templates.error)
      return (
        <ErrorNotice error={errorDetails(templates.error, t`Could not load templates`)}>
          <Button variant="outline" size="sm" onClick={() => void templates.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </ErrorNotice>
      );
    if (!templates.data)
      return (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      );
    if (open)
      return (
        <TemplateDetail
          template={open}
          onBack={() => setOpenId(null)}
          onOpenBot={onOpenBot}
          onChanged={() => void templates.refetch()}
        />
      );
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {templates.data.map((template) => {
          const { name, summary, sample } = copy(template);
          return (
            <button
              key={template.id}
              type="button"
              data-testid="bot-template-card"
              onClick={() => setOpenId(template.id)}
              className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-border/70 p-4 text-start focus-visible:outline-none ${ROW_HOVER}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <TemplateIcon id={template.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-lg font-medium text-foreground">
                    {name}
                  </span>
                  <span className="block truncate text-body-sm text-muted-foreground">
                    {summary}
                  </span>
                </span>
              </span>
              {/* A glimpse of the example; the template's page shows all of it. */}
              <span className="block h-40 overflow-hidden rounded-xl border border-border/60 bg-background px-3.5 py-2.5 text-body-sm mask-b-from-60%">
                <ChatMarkdown>{sample}</ChatMarkdown>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="bot-templates-dialog"
        size="lg"
        className="bg-card"
      >
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Bot templates</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close bot templates`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-8">{content()}</div>
      </DialogContent>
    </Dialog>
  );
}

function TemplateDetail({
  template,
  onBack,
  onOpenBot,
  onChanged,
}: {
  template: BotTemplateListing;
  onBack: () => void;
  onOpenBot: (bot: Bot) => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const { name, summary, sample } = useBotTemplateCopy()(template);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Set when the preview closes, so a request that finishes later doesn't open its bot.
  const left = useRef(false);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);
  const catalog = useQuery({
    ...queries.connections.catalog.queryOptions({ input: {} }),
    enabled: template.apps.length > 0,
  });
  const apps = botTemplateApps(template, catalog.data ?? []);
  const schedule = (crons: string[]) =>
    crons.map((cron) => formatCron(cron, cronLabels(i18n.locale))).join(", ");

  async function create() {
    setPending(true);
    setError(null);
    try {
      const { bot } = await rpc.bots.createFromTemplate({
        templateId: template.id,
        version: template.version,
        name,
      });
      if (!left.current) onOpenBot(bot);
    } catch (err) {
      if (left.current) return;
      const changed = isBotTemplateChanged(err);
      setError(
        errorDetails(
          changed ? t`This template was just updated. Check it again.` : err,
          t`Could not create the bot`,
        ),
      );
      if (changed) onChanged();
      setPending(false);
    }
  }

  async function openExisting(botId: string) {
    setPending(true);
    try {
      const bot = await rpc.bots.get({ botId });
      if (!left.current) onOpenBot(bot);
    } catch (err) {
      if (left.current) return;
      setError(errorDetails(err, t`Could not open the bot`));
      setPending(false);
    }
  }

  const rows: { key: string; icon: LucideIcon; title: string; detail: string; body?: string }[] = [
    {
      key: "bot",
      icon: BotIcon,
      title: name,
      detail: t`Instructions`,
      body: template.instructions,
    },
    ...template.skills.map((skill) => ({
      key: `skill:${skill.name}`,
      icon: ScrollText,
      title: skill.name,
      detail: t`Skill`,
      body: skill.body,
    })),
    ...template.routines.map((routine, index) => ({
      key: `routine:${index}`,
      icon: Clock,
      title: routine.name,
      detail: t`${schedule(routine.crons)}, paused until you turn it on`,
      body: routine.prompt,
    })),
  ];

  return (
    <div data-testid="bot-template-detail" className="space-y-7">
      <div className="flex items-start gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-3.5 -ms-2 text-muted-foreground"
          aria-label={t`Back`}
          disabled={pending}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <TemplateIcon id={template.id} large />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-heading2 font-semibold text-foreground">{name}</h2>
          <p className="truncate text-body text-muted-foreground">{summary}</p>
        </div>
        <div className="shrink-0 pt-2">
          {template.botId ? (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => void openExisting(template.botId!)}
            >
              <Trans>Open</Trans>
            </Button>
          ) : (
            <Button size="lg" className="px-5" disabled={pending} onClick={() => void create()}>
              {pending ? <Trans>Creating…</Trans> : <Trans>Create bot</Trans>}
            </Button>
          )}
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <Sample text={sample} />

      <section className="space-y-2">
        <SectionHeading className="px-1">
          <Trans>Adds</Trans>
        </SectionHeading>
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
          {rows.map((row) => {
            const Icon = row.icon;
            const isOpen = expanded === row.key;
            return (
              <li key={row.key}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : row.key)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start focus-visible:outline-none"
                >
                  <Icon size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{row.title}</span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {row.detail}
                    </span>
                  </span>
                  <ChevronDown
                    size={16}
                    className={`shrink-0 text-muted-foreground transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {isOpen && row.body ? (
                  <div className="mx-4 mb-3 rounded-lg bg-background px-3.5 py-2.5 text-body-sm">
                    <ChatMarkdown>{row.body}</ChatMarkdown>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {apps.length ? <AppsSection apps={apps} /> : null}
    </div>
  );
}

function AppsSection({ apps }: { apps: ConnectionCatalogItem[] }) {
  const { t } = useLingui();
  return (
    <section className="space-y-2">
      <SectionHeading className="px-1">
        <Trans>Works with</Trans>
      </SectionHeading>
      <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
        {apps.map((app) => (
          <li key={app.slug} className="flex items-center gap-3 px-4 py-3">
            <PluginLogo name={app.name} logo={app.logo} />
            <span className="min-w-0 flex-1 truncate text-body-lg font-medium">{app.name}</span>
            {app.connected ? (
              <Check role="img" aria-label={t`Connected`} className="size-4 text-success" />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
