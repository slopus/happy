/**
 * Client-side diff detection and a tiny summary — no dependencies (the CLI imports core, and must never pay for a diff
 * renderer). `looksLikeDiff` decides whether a decrypted message body is a unified/git diff; `summarizeDiff` derives
 * the compact "N files · +A −B" line for the collapsed card. The heavy rendering (diff2html) lives in the UI layer
 * only.
 */

/**
 * Whether the text reads as a unified diff. Recognises git diffs (`diff --git …`), a classic `---`/`+++` file-header
 * pair, or at least one hunk header (`@@ … @@`). Deliberately loose but anchored to line starts, so ordinary prose that
 * merely mentions `@@` or a leading `+` doesn't trip it.
 */
export const looksLikeDiff = (text: string): boolean => {
  if (text === '') return false
  if (/^diff --git /m.test(text)) return true
  if (/^@@ .* @@/m.test(text)) return true
  if (/^--- /m.test(text) && /^\+\+\+ /m.test(text)) return true
  return false
}

export interface DiffSummary {
  /** Number of files touched (git `diff --git` headers, else `+++` headers, else 1 for a headerless hunk). */
  files: number
  additions: number
  deletions: number
  /** First file path mentioned, if any — shown when there is a single file. */
  firstFile?: string
}

const stripFileMarker = (path: string): string => path.replace(/^[ab]\//, '')

/**
 * Count files and added/removed lines from a unified diff, without a full parser. Added/removed lines start with a
 * single `+`/`-` but not the `+++`/`---` file headers. Best-effort — good enough for a one-line card label.
 */
export const summarizeDiff = (text: string): DiffSummary => {
  const lines = text.split('\n')
  const files: string[] = []
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (gitHeader) {
      files.push(stripFileMarker(gitHeader[2]))
      continue
    }
    if (line.startsWith('+++ ')) {
      // Only used to count files when there's no `diff --git` header (plain unified diff).
      const path = line.slice(4).trim()
      if (path !== '' && path !== '/dev/null') files.push(stripFileMarker(path))
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('@@')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }

  // Dedupe: a git diff carries both `diff --git` and `+++` for the same file.
  const unique = [...new Set(files.filter((f) => f !== ''))]
  return {
    files: unique.length === 0 ? 1 : unique.length,
    additions,
    deletions,
    ...(unique.length === 1 ? { firstFile: unique[0] } : {}),
  }
}
