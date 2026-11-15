import type { CSSProperties, MouseEvent, ReactNode, RefObject } from "react";
import {
  Component,
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { HastNode } from "./table-utils";
import "./markdown.web.css";
import "./markdown-table.css";
import { droppedTableHtmlText } from "@rakazo/contracts";
import { cssVariableName, pageIconBars } from "@rakazo/ui-tokens";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  CopyTextFallback,
  useCopyText,
} from "@rakazo/ui-web";
import { CheckIcon, CopyIcon, GlobeIcon, ImageIcon } from "./icons";
import type { ChatMarkdownProps } from "./markdown";
import {
  closeUnterminatedFence,
  inlineMarkdownImageSrc,
  isProseFence,
  LinkFaviconsPausedContext,
  linkFaviconOrigin,
  linkLabel,
  markdownLinkDisplayParts,
  markdownLinkNeedsPrompt,
  markdownLinkSite,
  markdownMentionId,
  markdownPageId,
  markRemoteImageLoaded,
  plainTextLinkParts,
  RemoteImagesContext,
  remoteImageRenders,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
  useLinkFavicon,
} from "./markdown";
import { useMarkdownCopy } from "./markdown-copy";
import { useMarkdownLinkCopy, useMarkdownLinkTrust } from "./markdown-link-prompt";
import { MarkdownTable, MarkdownTableSourceContext } from "./markdown-table";
import { isMermaidFence, mermaidSvgImage } from "./mermaid";
import { useMermaidSvg } from "./mermaid.web";
import { PAGE_ICON } from "./page-icon";

function preserveSkippedTableText() {
  return (tree: HastNode) => {
    const walk = (node: HastNode, inTableCell = false) => {
      const insideCell = inTableCell || node.tagName === "th" || node.tagName === "td";
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (insideCell && child.type === "raw") {
          const value = droppedTableHtmlText(child.value ?? "");
          return value === null ? child : { type: "text", value };
        }
        walk(child, insideCell);
        return child;
      });
    };
    walk(tree);
  };
}

function CopyButton({ read, label }: { read: () => string; label: string }) {
  const copy = useMarkdownCopy();
  const [copied, copyText, copyFailed, resetCopy, failedText] = useCopyText();

  return (
    <>
      <button
        type="button"
        className="rk-chat-markdown-copy"
        onClick={() => copyText(read())}
        aria-label={copied ? copy.copied : label}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <CopyTextFallback
        open={copyFailed}
        onOpenChange={resetCopy}
        text={failedText}
        label={label}
      />
    </>
  );
}

function CodeBlock({
  copyable,
  prose,
  ...props
}: React.ComponentPropsWithoutRef<"pre"> & { copyable: boolean; prose: boolean }) {
  const copy = useMarkdownCopy();
  const preRef = useRef<HTMLPreElement>(null);
  // The parser ends a fence's code with a newline the author didn't write.
  const readCode = useCallback(() => (preRef.current?.textContent ?? "").replace(/\n$/, ""), []);

  return (
    <div className="rk-chat-markdown-pre-wrap">
      <pre {...props} className={prose ? "rk-chat-markdown-pre-prose" : undefined} ref={preRef} />
      {copyable ? <CopyButton read={readCode} label={copy.copyCode} /> : null}
    </div>
  );
}

/** Original markdown while streaming, before any display-only closing fence is appended. */
const StreamingSourceContext = createContext<string | undefined>(undefined);

function codeElement(node: MarkdownHast | undefined) {
  return node?.children?.find((child) => child.tagName === "code");
}

function codeText(code: MarkdownHast | undefined) {
  return (code?.children ?? []).map((child) => child.value ?? "").join("");
}

/** The language a fence names, or "" when it names none. */
function fenceLanguage(node: MarkdownHast | undefined): string {
  const classNames = codeElement(node)?.properties?.className;
  const language = Array.isArray(classNames)
    ? classNames.find((name) => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  return typeof language === "string" ? language.slice("language-".length) : "";
}

/** The source of a ```mermaid fence, or undefined for any other block. */
function mermaidFenceSource(node: MarkdownHast | undefined): string | undefined {
  const code = codeElement(node);
  if (!isMermaidFence(fenceLanguage(node))) {
    return undefined;
  }
  const source = codeText(code);
  return source.trim() ? source.trimEnd() : undefined;
}

function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const copy = useMarkdownCopy();
  const svg = useMermaidSvg(source);
  const readSource = useCallback(() => source, [source]);
  const image = svg ? mermaidSvgImage(svg) : undefined;
  // Rendering, or source Mermaid cannot draw: the code block keeps the content readable.
  if (!image) return fallback;
  return (
    <div className="rk-chat-markdown-pre-wrap">
      <figure className="rk-chat-markdown-diagram" data-testid="chat-diagram">
        {/* An image, not inline SVG: nothing in a diagram can script or style the page. */}
        <img
          src={image.src}
          width={image.width}
          height={image.height}
          alt={image.alt}
          style={{ "--rk-diagram-width": `${image.width}px` } as CSSProperties}
        />
      </figure>
      <CopyButton read={readSource} label={copy.copyDiagramSource} />
    </div>
  );
}

function MarkdownPre({
  node,
  ...props
}: React.ComponentPropsWithoutRef<"pre"> & { node?: MarkdownHast }) {
  const streamingSource = useContext(StreamingSourceContext);
  const diagram = mermaidFenceSource(node);
  // Prose an author wrote in a fence reads as prose; code keeps the monospaced font.
  const prose = diagram === undefined && isProseFence(fenceLanguage(node));
  // An empty fence has nothing to copy.
  const codeBlock = (
    <CodeBlock {...props} copyable={/\S/.test(codeText(codeElement(node)))} prose={prose} />
  );
  if (diagram === undefined) return codeBlock;
  // Parser offsets identify the fence inside quotes and lists too. Inspect the original source,
  // since a display-only closing fence must never trigger a diagram render.
  if (streamingSource !== undefined) {
    const start = node?.position?.start?.offset;
    const end = node?.position?.end?.offset;
    const fence = start === undefined ? "" : streamingSource.slice(start, end);
    const opening = fence.match(/^(`{3,}|~{3,})/);
    const lastLine = fence.slice(fence.lastIndexOf("\n") + 1);
    const closing = lastLine.match(/^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/);
    if (
      !fence.includes("\n") ||
      !opening?.[1] ||
      !closing?.[1] ||
      opening[1][0] !== closing[1][0] ||
      closing[1].length < opening[1].length
    ) {
      return codeBlock;
    }
  }
  return <MermaidDiagram source={diagram} fallback={codeBlock} />;
}

type EnclosingLink = false | "open" | "rejected";

const InsideLinkContext = createContext<EnclosingLink>(false);

const ConfirmLinkContext = createContext<(url: string) => void>(() => undefined);

function pageOrigin() {
  if (typeof window === "undefined") return null;
  const origin = window.location.origin;
  return origin && origin !== "null" ? origin : null;
}

function holdExternalLink(
  event: MouseEvent<HTMLAnchorElement>,
  request: (url: string) => void,
  trustedSites: readonly string[],
) {
  if (event.button !== 0 && event.button !== 1) return;
  const destination = event.currentTarget.href;
  if (!destination || !markdownLinkNeedsPrompt(destination, pageOrigin(), trustedSites)) return;
  event.preventDefault();
  request(destination);
}

function ExternalLinkUrl({ url }: { url: string }) {
  const parts = markdownLinkDisplayParts(url);
  if (!parts) return url;
  return (
    <>
      {parts.before}
      <strong className="font-semibold">{parts.host}</strong>
      {parts.after}
    </>
  );
}

function openExternalLink(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function ExternalLinkAlert({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  const copy = useMarkdownLinkCopy();
  const { trust } = useMarkdownLinkTrust();
  const site = trust ? markdownLinkSite(url) : undefined;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription className="break-all text-left text-foreground">
            <ExternalLinkUrl url={url} />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
          {trust && site ? (
            <AlertDialogAction
              variant="outline"
              className="h-auto min-h-8 shrink whitespace-normal break-all"
              onClick={() => {
                openExternalLink(url);
                trust(url);
                onDismiss();
              }}
            >
              {copy.alwaysOpen(site)}
            </AlertDialogAction>
          ) : null}
          <AlertDialogAction
            onClick={() => {
              openExternalLink(url);
              onDismiss();
            }}
          >
            {copy.open}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function useExternalLinkConfirm() {
  const [url, setUrl] = useState<string | null>(null);
  const request = useCallback((destination: string) => {
    setUrl(destination);
  }, []);
  const dialog = url ? <ExternalLinkAlert url={url} onDismiss={() => setUrl(null)} /> : null;
  return { request, dialog };
}

/** Opens a link the way a chat link opens: through the prompt unless it is in-app or trusted. */
export function useExternalLinkOpener(): { open: (url: string) => void; dialog: ReactNode } {
  const { request, dialog } = useExternalLinkConfirm();
  const { sites } = useMarkdownLinkTrust();
  const open = useCallback(
    (url: string) => {
      if (markdownLinkNeedsPrompt(url, pageOrigin(), sites)) request(url);
      else openExternalLink(url);
    },
    [request, sites],
  );
  return { open, dialog };
}

/** Sends clicks on links drawn inside an element, such as a chart's SVG, through the prompt. */
export function useLinkPrompt(container: RefObject<HTMLElement | null>): ReactNode {
  const { open, dialog } = useExternalLinkOpener();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const hold = (event: globalThis.MouseEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      const href = anchor && element.contains(anchor) ? anchor.getAttribute("href") : null;
      if (!href) return;
      event.preventDefault();
      open(new URL(href, document.baseURI).href);
    };
    element.addEventListener("click", hold);
    element.addEventListener("auxclick", hold);
    return () => {
      element.removeEventListener("click", hold);
      element.removeEventListener("auxclick", hold);
    };
  }, [container, open]);
  return dialog;
}

function ConfirmableAnchor({ href, ...props }: React.ComponentPropsWithoutRef<"a">) {
  const request = useContext(ConfirmLinkContext);
  const { sites } = useMarkdownLinkTrust();
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => holdExternalLink(event, request, sites)}
      onAuxClick={(event) => holdExternalLink(event, request, sites)}
    />
  );
}

type MarkdownHast = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownHast[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

function hastString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function linkHost(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

function soleRemoteImage(node: MarkdownHast | undefined):
  | {
      href: string;
      host: string;
      alt?: string;
      title?: string;
    }
  | undefined {
  const parts = (node?.children ?? []).filter((child) => {
    if (child.type === "text") return Boolean(child.value?.trim());
    return child.type === "element";
  });
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.tagName !== "img") return undefined;
  const remote = remoteMarkdownImage(hastString(only.properties?.src) ?? "");
  if (!remote) return undefined;
  return {
    ...remote,
    alt: hastString(only.properties?.alt),
    title: hastString(only.properties?.title),
  };
}

function RemoteImageButton({
  image,
  alt,
  title,
  onLoad,
}: {
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  onLoad: () => void;
}) {
  return (
    <button
      type="button"
      className="rk-chat-markdown-image"
      title={title}
      onClick={() => {
        markRemoteImageLoaded(image.href);
        onLoad();
      }}
    >
      <ImageIcon />
      {alt ? <span>{alt}</span> : null}
      <span className="rk-chat-markdown-image-host">{image.host}</span>
    </button>
  );
}

function MarkdownImage({ src = "", alt, title }: { src?: string; alt?: string; title?: string }) {
  const enclosingLink = useContext(InsideLinkContext);
  const loadRemote = useContext(RemoteImagesContext);
  const remote = remoteMarkdownImage(src);
  // Bumping this redraws after a tap. Whether the image shows is read from the current URL.
  const [, setRevision] = useState(0);
  const rejectedLink = enclosingLink === "rejected";
  if (inlineMarkdownImageSrc(src)) {
    return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
  }
  if (remote && remoteImageRenders(remote.href, loadRemote, rejectedLink)) {
    return (
      <img
        src={remote.href}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (!remote || enclosingLink !== false) return alt || remote?.host || src;
  return (
    <RemoteImageButton
      image={remote}
      alt={alt}
      title={title}
      onLoad={() => setRevision((revision) => revision + 1)}
    />
  );
}

function LinkedRemoteImage({
  href,
  image,
  alt,
  title,
}: {
  href: string;
  image: { href: string; host: string };
  alt?: string;
  title?: string;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, false)) {
    return (
      <ConfirmableAnchor href={href}>
        <img
          src={image.href}
          alt={alt ?? ""}
          title={title}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </ConfirmableAnchor>
    );
  }
  return (
    <span className="rk-chat-markdown-linked-image">
      <RemoteImageButton
        image={image}
        alt={alt}
        title={title}
        onLoad={() => setRevision((revision) => revision + 1)}
      />
      <ConfirmableAnchor href={href}>{linkHost(href)}</ConfirmableAnchor>
    </span>
  );
}

/** The label when it is plain text, the only kind that can be a bare URL. */
function hastText(node: MarkdownHast | undefined): string | undefined {
  const children = node?.children ?? [];
  if (!children.every((child) => child.type === "text")) return undefined;
  return children.map((child) => child.value ?? "").join("");
}

function hastHasImage(node: MarkdownHast | undefined): boolean {
  return (node?.children ?? []).some((child) => child.tagName === "img" || hastHasImage(child));
}

function LinkFavicon({ href }: { href: string }) {
  const { icon, unusable } = useLinkFavicon(href);
  return (
    <span
      aria-hidden="true"
      className={icon ? "rk-chat-link-tile rk-chat-link-tile-icon" : "rk-chat-link-tile"}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          draggable={false}
          onLoad={(event) => {
            // A 1×1 image is a tracking pixel, not an icon.
            const image = event.currentTarget;
            if (image.naturalWidth <= 1 || image.naturalHeight <= 1) unusable();
          }}
          onError={unusable}
        />
      ) : (
        <GlobeIcon />
      )}
    </span>
  );
}

/** A link to a website, drawn with its site icon before the label. */
function WebsiteLink({
  href,
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { href: string; children: ReactNode }) {
  return (
    <ConfirmableAnchor
      {...props}
      href={href}
      className={className ? `rk-chat-link ${className}` : "rk-chat-link"}
    >
      <LinkFavicon href={href} />
      {/* bdi: direction characters in a label cannot reorder the text around the link. */}
      <bdi className="rk-chat-link-label">{children}</bdi>
    </ConfirmableAnchor>
  );
}

function MarkdownAnchor({
  node,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { node?: MarkdownHast }) {
  const loadRemote = useContext(RemoteImagesContext);
  const { renderMention, onOpenPage: openPage } = useContext(InlineChipsContext);
  const href = typeof props.href === "string" ? props.href : "";
  const pageId = markdownPageId(href);
  if (pageId) {
    return (
      <PageChip pageId={pageId} openPage={openPage}>
        {props.children}
      </PageChip>
    );
  }
  const mentionId = markdownMentionId(href);
  if (mentionId) {
    const name = hastText(node) ?? "";
    return renderMention?.(mentionId, name) ?? <span>{props.children}</span>;
  }
  const image = href ? soleRemoteImage(node) : undefined;
  if (image && !remoteImageRenders(image.href, loadRemote, false)) {
    return <LinkedRemoteImage href={href} image={image} alt={image.alt} title={image.title} />;
  }
  // urlTransform blanks unsafe URLs. Keep their text without a link that opens the app again.
  const opens = Boolean(props.href);
  const text = hastText(node);
  const link =
    opens && linkFaviconOrigin(href) && !hastHasImage(node) ? (
      <WebsiteLink {...props} href={href}>
        {text === undefined ? props.children : linkLabel(text, href)}
      </WebsiteLink>
    ) : opens ? (
      <ConfirmableAnchor {...props} />
    ) : (
      <span>{props.children}</span>
    );
  return (
    <InsideLinkContext.Provider value={opens ? "open" : "rejected"}>
      {link}
    </InsideLinkContext.Provider>
  );
}

function PageChip({
  pageId,
  openPage,
  children,
}: {
  pageId: string;
  openPage: ((pageId: string) => void) | undefined;
  children: ReactNode;
}) {
  return openPage ? (
    <button type="button" className="rk-chat-page-chip" onClick={() => openPage(pageId)}>
      <PageIcon className="rk-chat-page-chip-icon" />
      <span className="rk-chat-page-chip-title">{children}</span>
    </button>
  ) : (
    <span>{children}</span>
  );
}

/** What a chip in the text does: a mention's rendering, and opening a linked page. */
const InlineChipsContext = createContext<Pick<ChatMarkdownProps, "renderMention" | "onOpenPage">>(
  {},
);

/** The page icon (see `PAGE_ICON`), sized by its container. */
export function PageIcon({ className }: { className?: string }) {
  const { width: w, height: h, radius: r, foldX, foldY } = PAGE_ICON;
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${w} ${h}`} className={className}>
      <path
        d={`M${r} 0.25H${foldX}L${w - 0.25} ${foldY}V${h - r}A${r - 0.25} ${r - 0.25} 0 0 1 ${w - r} ${h - 0.25}H${r}A${r - 0.25} ${r - 0.25} 0 0 1 0.25 ${h - r}V${r}A${r - 0.25} ${r - 0.25} 0 0 1 ${r} 0.25Z`}
        fill="var(--page-icon-sheet)"
        stroke="var(--page-icon-edge)"
        strokeWidth="0.5"
      />
      <path
        d={`M${foldX} 0.25L${w - 0.25} ${foldY}H${foldX + 2}A2 2 0 0 1 ${foldX} ${foldY - 2}Z`}
        fill="var(--page-icon-fold)"
      />
      {PAGE_ICON.lines.map((line) => (
        <rect
          key={line.y}
          x={line.x}
          y={line.y}
          width={line.width}
          height={line.height}
          rx={line.height / 2}
          fill={`var(${cssVariableName(line.token)})`}
        />
      ))}
      {PAGE_ICON.bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width={PAGE_ICON.barWidth}
          height={bar.height}
          rx={PAGE_ICON.barWidth / 2}
          fill={pageIconBars[index]}
        />
      ))}
    </svg>
  );
}

const components: Components = {
  a: MarkdownAnchor,
  img({ node: _node, src, alt, title }) {
    return (
      <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} />
    );
  },
  pre: MarkdownPre,
  table({ node, children, ...props }) {
    return (
      <MarkdownTable node={node} tableProps={props}>
        {children}
      </MarkdownTable>
    );
  },
};

type PlainTextState = { text: string; failed: boolean };

/** The parser recurses, so a pathological message can exhaust the stack; show it as plain text. */
class PlainTextOnFailure extends Component<{ text: string; children: ReactNode }, PlainTextState> {
  override state = { text: this.props.text, failed: false };

  static getDerivedStateFromProps(props: { text: string }, state: PlainTextState) {
    return props.text === state.text ? null : { text: props.text, failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? (
      <p className="whitespace-pre-wrap">{this.props.text}</p>
    ) : (
      this.props.children
    );
  }
}

export function LinkifiedText({
  children,
  onOpenPage,
}: {
  children: string;
  onOpenPage?: (pageId: string) => void;
}) {
  const { request, dialog } = useExternalLinkConfirm();
  return (
    <ConfirmLinkContext.Provider value={request}>
      {plainTextLinkParts(children).map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : part.type === "page" ? (
          <PageChip key={index} pageId={part.pageId} openPage={onOpenPage}>
            {part.value}
          </PageChip>
        ) : linkFaviconOrigin(part.href) ? (
          <WebsiteLink key={index} href={part.href} className="rk-chat-link-in-bubble">
            {linkLabel(part.value, part.href)}
          </WebsiteLink>
        ) : (
          <ConfirmableAnchor key={index} href={part.href} className="underline">
            {part.value}
          </ConfirmableAnchor>
        ),
      )}
      {dialog}
    </ConfirmLinkContext.Provider>
  );
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [preserveSkippedTableText];

// MarkdownImage decides what an image source may do, so it receives the source as written.
function urlTransform(url: string, key: string) {
  return key === "src" || markdownMentionId(url) || markdownPageId(url)
    ? url
    : (sanitizeMarkdownUrl(url, true) ?? "");
}

const MarkdownBlock = memo(function MarkdownBlock({
  source,
  streaming,
}: {
  source: string;
  streaming: boolean;
}) {
  const parsed = streaming ? closeUnterminatedFence(source) : source;
  return (
    <StreamingSourceContext.Provider value={streaming ? source : undefined}>
      <MarkdownTableSourceContext.Provider value={parsed}>
        <ReactMarkdown
          components={components}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          skipHtml
          urlTransform={urlTransform}
        >
          {parsed}
        </ReactMarkdown>
      </MarkdownTableSourceContext.Provider>
    </StreamingSourceContext.Provider>
  );
});

// A block is keyed by its kind and how many of that kind precede it, as react-markdown keys
// elements, so a table keeps its sort, page and dialog when text before it changes.
type SourceBlock = { start: number; source: string; type: string; key: string };
type SplitSource = { text: string; blocks: SourceBlock[] };

const blockParser = unified().use(remarkParse).use(remarkGfm);
// Link and footnote definitions apply to the whole document, so such text is never split.
const definition = /\]:/;

/**
 * Top-level blocks of streamed text. Appended text can still change the last block, or join the
 * one before it (a list continued after a blank line), so only those two are parsed again.
 */
function splitSource(text: string, previous: SplitSource | undefined): SplitSource {
  const whole = { text, blocks: [{ start: 0, source: text, type: "root", key: "root-0" }] };
  if (definition.test(text)) return whole;
  const kept = previous && text.startsWith(previous.text) ? previous.blocks.slice(0, -2) : [];
  const from = previous?.blocks[kept.length]?.start ?? 0;
  const tail = text.slice(from);
  let parsed: { start: number; type: string }[];
  try {
    parsed = blockParser.parse(tail).children.map((child, index) => ({
      start: index === 0 ? 0 : tail.lastIndexOf("\n", (child.position?.start.offset ?? 1) - 1) + 1,
      type: child.type,
    }));
  } catch {
    return whole;
  }
  if (parsed.length === 0) parsed = [{ start: 0, type: "root" }];
  const counts = new Map<string, number>();
  for (const block of kept) counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
  return {
    text,
    blocks: [
      ...kept,
      ...parsed.map(({ start, type }, index) => {
        const count = counts.get(type) ?? 0;
        counts.set(type, count + 1);
        return {
          start: from + start,
          source: tail.slice(start, parsed[index + 1]?.start ?? tail.length),
          type,
          key: `${type}-${count}`,
        };
      }),
    ],
  };
}

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  renderMention,
  onOpenPage,
}: ChatMarkdownProps) {
  const { request, dialog } = useExternalLinkConfirm();
  // A streamed reply stays split once it finishes, so its blocks are not drawn again.
  const [split, setSplit] = useState(streaming);
  if (streaming && !split) setSplit(true);
  const previousSplit = useRef<SplitSource | undefined>(undefined);
  const blocks = useMemo(() => {
    if (!split) return undefined;
    previousSplit.current = splitSource(children, previousSplit.current);
    return previousSplit.current.blocks;
  }, [children, split]);

  const inlineChips = useMemo(() => ({ renderMention, onOpenPage }), [renderMention, onOpenPage]);
  return (
    <ConfirmLinkContext.Provider value={request}>
      <InlineChipsContext.Provider value={inlineChips}>
        <div
          className={streaming ? "rk-chat-markdown rk-chat-markdown-streaming" : "rk-chat-markdown"}
        >
          <LinkFaviconsPausedContext.Provider value={streaming}>
            <PlainTextOnFailure text={children}>
              {blocks ? (
                blocks.map((block, index) => (
                  <Fragment key={block.key}>
                    {/* The line break react-markdown puts between blocks, so the DOM matches. */}
                    {index > 0 ? "\n" : null}
                    <MarkdownBlock
                      source={block.source}
                      streaming={streaming && index === blocks.length - 1}
                    />
                  </Fragment>
                ))
              ) : (
                <MarkdownBlock source={children} streaming={streaming} />
              )}
            </PlainTextOnFailure>
          </LinkFaviconsPausedContext.Provider>
          {streaming ? <span aria-hidden="true" className="rk-chat-markdown-cursor" /> : null}
        </div>
      </InlineChipsContext.Provider>
      {dialog}
    </ConfirmLinkContext.Provider>
  );
});

export type { ChatMarkdownProps, LinkFavicons } from "./markdown";
export {
  LinkFaviconsContext,
  RemoteImagesContext,
  useLinkFavicon,
  withBlockMentions,
} from "./markdown";
export type { MarkdownCopy } from "./markdown-copy";
export { defaultMarkdownCopy, MarkdownCopyProvider } from "./markdown-copy";
export { MarkdownLinkPromptProvider } from "./markdown-link-prompt";
