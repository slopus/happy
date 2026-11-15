import type { CSSProperties, ReactNode } from "react";
import {
  Children,
  createContext,
  createElement,
  isValidElement,
  useContext,
  useEffect,
  useState,
} from "react";
import { ErrorBoundary } from "./boundary.js";
import { Inline, Link, webUrl } from "./inline.js";
import { documentLanguage, PageLanguage, wordsFor } from "./labels.js";
import { PageHero, PageMeta, slugify } from "./text.js";

/**
 * Blocks a Section caption describes: it sits under the first of them, like a figure caption,
 * and under the first block when the section has none. Filled in by the kit index.
 */
export const FIGURES = new Set<unknown>();

// A section or property list placed in a grid sits beside others, so it becomes a bordered card.
export const InGrid = createContext(false);
// Nested sections step down a heading level: h2 at the top of the page, then h3, and so on.
const Depth = createContext(0);

const WIDTHS = new Set(["column", "wide", "full"]);
const InPage = createContext(false);

const COLOR = /^(#[0-9a-f]{3,8}|(?:rgb|hsl|oklch|oklab)a?\([^;{}]*\))$/i;

export function Page({
  title,
  summary,
  width = "column",
  lang,
  palette,
  sources,
  children,
}: {
  title: string;
  summary?: string;
  width?: "column" | "wide" | "full" | "normal";
  lang?: string;
  palette?: string[];
  sources?: string[];
  children?: ReactNode;
}) {
  // A page component named like a kit one (Status, Table) renders itself inside its own Page
  // forever, hanging the viewer; failing here shows an error instead.
  if (useContext(InPage)) {
    throw new Error(
      "<Page> was rendered inside another <Page>. Usually the page's own component has a kit component's name (such as Status or Table), so using that component renders the page again. Rename the page's component.",
    );
  }
  useEffect(() => {
    document.title = title;
  }, [title]);
  const own = typeof lang === "string" && lang.trim() ? lang.trim() : undefined;
  // Without its own lang, a page's built-in words follow the reader's app language.
  const inherited = useContext(PageLanguage);
  const language = own ?? inherited ?? documentLanguage();
  const words = wordsFor(language);
  useEffect(() => {
    if (!own) return;
    document.documentElement.lang = own;
    document.documentElement.dir = wordsFor(own).dir;
  }, [own]);
  const links = Array.isArray(sources)
    ? sources.filter((source) => typeof source === "string")
    : [];
  // A hero given first goes above the title, where a cover image belongs.
  const blocks = Children.toArray(children);
  const hero = isValidElement(blocks[0]) && blocks[0].type === PageHero ? blocks.shift() : null;
  // A byline given before the content belongs under the summary.
  const meta = isValidElement(blocks[0]) && blocks[0].type === PageMeta ? blocks.shift() : null;
  const colors = Array.isArray(palette)
    ? Object.fromEntries(
        palette
          .slice(0, 5)
          .map((color, index) => [`--rk-c${index + 1}`, color] as const)
          .filter(([, color]) => typeof color === "string" && COLOR.test(color.trim())),
      )
    : undefined;
  return (
    <InPage.Provider value={true}>
      <PageLanguage.Provider value={language}>
        <main
          className="rk-page"
          data-width={WIDTHS.has(width) ? width : "column"}
          lang={own}
          dir={own ? words.dir : undefined}
          style={colors as CSSProperties}
        >
          <header className="rk-header">
            {hero}
            <h1 className="rk-title">{title}</h1>
            {summary ? (
              <p className="rk-summary">
                <Inline>{summary}</Inline>
              </p>
            ) : null}
            {meta}
          </header>
          {blocks}
          {links.length ? (
            <footer className="rk-sources">
              <h2 className="rk-sources-heading">{words.t("sources")}</h2>
              <ol>
                {links.map((source, index) => {
                  const href = webUrl(source);
                  return <li key={index}>{href ? <Link href={href}>{source}</Link> : source}</li>;
                })}
              </ol>
            </footer>
          ) : null}
        </main>
      </PageLanguage.Provider>
    </InPage.Provider>
  );
}

export function Section({
  heading,
  id,
  caption,
  actions,
  collapsible = false,
  defaultOpen = false,
  children,
}: {
  heading?: string;
  id?: string;
  caption?: string;
  actions?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const card = useContext(InGrid);
  const depth = useContext(Depth);
  const folds = Boolean(collapsible && heading);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const anchor =
    typeof id === "string" && id ? id : typeof heading === "string" ? slugify(heading) : "";
  const title = folds ? (
    <button
      type="button"
      className="rk-section-toggle"
      aria-expanded={open}
      onClick={(event) => {
        // Preserve pointer text selection without blocking keyboard activation.
        if (event.detail === 0 || !window.getSelection()?.toString()) setOpen(!open);
      }}
    >
      <svg width="16" height="16" viewBox="-2 -2 16 16" aria-hidden="true">
        <path
          d="M3 4.5l3 3 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>{heading}</span>
    </button>
  ) : (
    heading
  );
  const head =
    heading || actions ? (
      <div className="rk-section-head">
        {heading
          ? createElement(`h${Math.min(6, depth + 2)}`, { className: "rk-heading" }, title)
          : null}
        {actions ? <div className="rk-actions">{actions}</div> : null}
      </div>
    ) : null;
  const blocks = Children.toArray(children);
  if (caption) {
    // Under the first figure it describes; with none, under the first block.
    const figure = blocks.findIndex((child) => isValidElement(child) && FIGURES.has(child.type));
    blocks.splice(
      figure < 0 ? Math.min(1, blocks.length) : figure + 1,
      0,
      <p className="rk-caption" data-figure key="rk-caption">
        {caption}
      </p>,
    );
  }
  return (
    <section
      className="rk-section"
      id={anchor || undefined}
      data-card={card || undefined}
      data-headed={heading ? true : undefined}
      data-collapsible={folds || undefined}
    >
      {head}
      <Depth.Provider value={depth + 1}>
        <InGrid.Provider value={false}>
          {folds ? (
            <div className="rk-section-fold" data-open={open || undefined} inert={!open}>
              <div className="rk-section-body">
                <ErrorBoundary>{blocks}</ErrorBoundary>
              </div>
            </div>
          ) : (
            <ErrorBoundary>{blocks}</ErrorBoundary>
          )}
        </InGrid.Provider>
      </Depth.Provider>
    </section>
  );
}

export function Grid({ columns = 2, children }: { columns?: number; children?: ReactNode }) {
  const count = Math.min(4, Math.max(1, Math.round(Number(columns)) || 1));
  return (
    <div className="rk-grid" style={{ "--rk-columns": count } as CSSProperties}>
      <InGrid.Provider value={true}>{children}</InGrid.Provider>
    </div>
  );
}

export function Text({ children }: { children?: ReactNode }) {
  return (
    <p className="rk-text">
      <Inline>{children}</Inline>
    </p>
  );
}

const CALLOUT_TONES = new Set(["info", "success", "warning", "danger"]);

// One stroke weight for all four, drawn on a 16px grid so they sit on the lead's first line.
const TONE_PATHS: Record<string, string> = {
  info: "M8 7.25v4M8 4.75v.01",
  success: "M5.25 8.25l1.9 1.9 3.6-3.9",
  warning: "M8 6.25v3M8 11.5v.01",
  danger: "M8 4.75v4M8 11.25v.01",
};

function ToneIcon({ tone }: { tone: string }) {
  return (
    <svg className="rk-callout-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {tone === "warning" ? (
        <path d="M7.13 2.5a1 1 0 011.74 0l5.5 9.75a1 1 0 01-.87 1.5H2.5a1 1 0 01-.87-1.5z" />
      ) : (
        <circle cx="8" cy="8" r="6.25" />
      )}
      <path d={TONE_PATHS[tone]} />
    </svg>
  );
}

export function Callout({
  lead,
  tone,
  children,
}: {
  lead?: string;
  tone?: "info" | "success" | "warning" | "danger";
  children?: ReactNode;
}) {
  if (!lead && (children === undefined || children === null || children === "")) return null;
  const toned = tone && CALLOUT_TONES.has(tone) ? tone : undefined;
  return (
    <div className="rk-callout" role="note" data-tone={toned}>
      {toned ? <ToneIcon tone={toned} /> : null}
      <div className="rk-callout-text">
        {lead ? <p className="rk-callout-lead">{lead}</p> : null}
        {children !== undefined && children !== null && children !== "" ? (
          <p className="rk-callout-body">
            <Inline>{children}</Inline>
          </p>
        ) : null}
      </div>
    </div>
  );
}
