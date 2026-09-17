import { html as renderDiffHtml } from 'diff2html'
import { useEffect, useMemo, useState } from 'react'
import { summarizeDiff } from '../../core/diff.js'
import { Button } from '../components/button.js'
import { cn } from '../utils.js'

/**
 * Diff rendering for the chat. A diff message is detected upstream (core `looksLikeDiff`) and shown as a compact
 * `DiffCard`; clicking it opens `DiffModal`, which renders the patch with diff2html (line-by-line or side-by-side).
 * Both are pure React — state is local. diff2html is an optional peer dependency, pulled in only here (never by the
 * CLI): the web app bundles it, the site provides it, CLI-only consumers never pay for it.
 *
 * diff2html's own stylesheet is intentionally NOT imported; instead the markup is styled below against our theme
 * tokens, so light/dark track the rest of the app exactly (no separate diff2html dark CSS to keep in sync).
 */

const cardLabel = (text: string): { label: string; additions: number; deletions: number } => {
  const s = summarizeDiff(text)
  const label = s.firstFile ?? `${s.files} ${s.files === 1 ? 'file' : 'files'}`
  return { label, additions: s.additions, deletions: s.deletions }
}

/** The collapsed representation of a diff message in the chat: a click target that opens the full modal. */
export const DiffCard = ({ text, onOpen }: { text: string; onOpen: () => void }) => {
  const { label, additions, deletions } = useMemo(() => cardLabel(text), [text])
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full max-w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted/70"
    >
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
        diff
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
        <span className="text-success">+{additions}</span>
        <span className="text-destructive">−{deletions}</span>
        <span className="text-muted-foreground group-hover:text-foreground">↗</span>
      </span>
    </button>
  )
}

type OutputFormat = 'line-by-line' | 'side-by-side'

/** A modal that renders a unified diff with diff2html. Close with Esc, the backdrop, or ×. */
export const DiffModal = ({ text, title, onClose }: { text: string; title?: string; onClose: () => void }) => {
  const [format, setFormat] = useState<OutputFormat>('line-by-line')

  const markup = useMemo(
    () => renderDiffHtml(text, { drawFileList: false, matching: 'lines', outputFormat: format }),
    [text, format],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const tab = (value: OutputFormat, text_: string) => (
    <button
      type="button"
      onClick={() => setFormat(value)}
      className={cn(
        'rounded-full border border-border px-2.5 py-0.5 font-accent text-xs transition-colors select-none hover:bg-muted/60',
        format === value && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
      )}
    >
      {text_}
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'diff'}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate font-title text-sm font-semibold text-accent-foreground">
            {title ?? 'diff'}
          </span>
          <div className="flex items-center gap-1.5">
            {tab('line-by-line', 'unified')}
            {tab('side-by-side', 'split')}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="close" onClick={onClose}>
            ×
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="ap-diff2html" dangerouslySetInnerHTML={{ __html: markup }} />
        </div>
      </div>
      <style>{DIFF2HTML_THEME_CSS}</style>
    </div>
  )
}

/**
 * A compact diff2html stylesheet mapped onto our theme tokens. Scoped under `.ap-diff2html` so it never leaks. Colors
 * come from the CSS variables (`--success`, `--destructive`, `--muted`, …) which already switch with the theme via
 * `light-dark()`, so this looks correct in both light and dark without a second dark stylesheet.
 */
const DIFF2HTML_THEME_CSS = `
.ap-diff2html { color: var(--foreground); font-size: 12px; }
.ap-diff2html .d2h-wrapper { text-align: left; }
.ap-diff2html .d2h-file-wrapper {
  border: 1px solid var(--border); border-radius: var(--radius-md);
  margin-bottom: 12px; overflow: hidden;
}
.ap-diff2html .d2h-file-wrapper:last-child { margin-bottom: 0; }
.ap-diff2html .d2h-file-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; background: var(--muted); border-bottom: 1px solid var(--border);
}
.ap-diff2html .d2h-file-name-wrapper { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ap-diff2html .d2h-file-name {
  font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--foreground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ap-diff2html .d2h-icon { fill: var(--muted-foreground); }
.ap-diff2html .d2h-tag, .ap-diff2html .d2h-file-stats { display: none; }
.ap-diff2html .d2h-diff-table {
  width: 100%; border-collapse: collapse;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5;
}
.ap-diff2html .d2h-diff-tbody > tr { background: var(--card); }
.ap-diff2html td { padding: 0; vertical-align: top; }
.ap-diff2html .d2h-code-linenumber, .ap-diff2html .d2h-code-side-linenumber {
  color: var(--muted-foreground); background: var(--muted); border-right: 1px solid var(--border);
  text-align: right; padding: 0 6px; user-select: none;
  width: 1%; min-width: 40px; white-space: nowrap;
}
.ap-diff2html .d2h-code-side-linenumber { position: static; }
.ap-diff2html .d2h-code-line, .ap-diff2html .d2h-code-side-line {
  padding: 0 8px; white-space: pre-wrap; word-break: break-word;
}
.ap-diff2html .d2h-code-line-prefix { user-select: none; opacity: 0.6; }
.ap-diff2html .d2h-code-line-ctn { display: inline-block; }
.ap-diff2html .d2h-del { background: color-mix(in oklab, var(--destructive) 12%, transparent); }
.ap-diff2html .d2h-ins { background: color-mix(in oklab, var(--success) 14%, transparent); }
.ap-diff2html .d2h-info {
  background: var(--muted); color: var(--muted-foreground);
}
.ap-diff2html .d2h-code-line del, .ap-diff2html .d2h-code-side-line del {
  background: color-mix(in oklab, var(--destructive) 26%, transparent); text-decoration: none; border-radius: 2px;
}
.ap-diff2html .d2h-code-line ins, .ap-diff2html .d2h-code-side-line ins {
  background: color-mix(in oklab, var(--success) 26%, transparent); text-decoration: none; border-radius: 2px;
}
.ap-diff2html .d2h-emptyplaceholder, .ap-diff2html .d2h-code-side-emptyplaceholder {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
}
.ap-diff2html .d2h-files-diff { display: flex; width: 100%; }
.ap-diff2html .d2h-file-side-diff { width: 50%; overflow-x: auto; }
.ap-diff2html .d2h-file-side-diff:first-child { border-right: 1px solid var(--border); }
`
