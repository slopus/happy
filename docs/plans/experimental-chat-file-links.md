# Experimental Chat File Links

## Problem

Codex is emitting local file references as absolute-path markdown links because the upstream prompt bundle says:

- `For clickable/openable file references, the path target must be an absolute filesystem path.`
- `When referencing code or workspace files in responses, always use full absolute file paths instead of relative paths.`

Happy does not currently implement that contract. The chat renderer only handles:

- explicit markdown links
- bare `http(s)` URLs

That creates two broken cases:

1. Absolute markdown file links are treated as ordinary browser links on web, so `/Users/.../file.ts:12` becomes `http://localhost/...`.
2. Bare relative file refs like `packages/foo.ts:12` are rendered as plain text because they are never auto-linkified.

## Goals

- Gate the entire feature behind the existing `experiments` setting.
- Support both absolute and relative file refs in chat.
- Route file refs into the internal file viewer instead of the browser.
- Canonicalize paths before calling the RPC layer.
- Keep external links working exactly as they do today.

## Control Flow

1. Parse markdown as today.
2. When rendering spans:
   - If `experiments` is off, keep existing behavior.
   - If a span is inline code, do not auto-link file refs.
   - If a span already has a URL, try to parse it as a file ref first.
   - If a span is plain text, scan whitespace-delimited tokens for file refs.
3. If a candidate parses as a file ref:
   - Resolve it to one canonical absolute path.
   - Push `/session/:id/file?path=<base64(abs)>&line=<n>&column=<n>`.
   - Do not expose it as a browser `href`.
4. In the file viewer:
   - Decode the incoming path.
   - Resolve relative input against the session root.
   - Normalize to a canonical absolute path.
   - Read the file through RPC using the canonical absolute path.
   - If the file is inside the session root, compute a repo-relative path for `git diff`.
   - If the file is outside the session root, skip diff and show the file directly.
5. In the RPC layer:
   - Resolve the incoming path to a canonical absolute path.
   - Validate access using the canonical absolute path.
   - Read/write/list using the canonical absolute path, not the raw input.

## Supported Cases

- Explicit markdown absolute links like `[foo.ts:12](/Users/me/repo/foo.ts:12)`
- Explicit markdown relative links like `[foo.ts:12](packages/app/foo.ts:12)`
- Bare absolute refs like `/Users/me/repo/foo.ts:12`
- Bare relative refs like `packages/app/foo.ts:12`
- Optional `:line`
- Optional `:line:column`
- Windows drive paths like `C:\repo\foo.ts:12`

## Rejected Cases

- External URLs like `https://...`
- URI schemes like `mailto:` and `node:`
- Plain prose tokens that do not look file-like
- Inline code spans and fenced code blocks

## Viewer Semantics

- The route accepts either absolute or relative `path` values for backwards compatibility.
- Internally, the viewer normalizes to a canonical absolute path.
- Diff view is shown only when the file is inside the session root and `git diff` returns content.
- A `line` query forces file view and scrolls near the requested line.

## RPC Semantics

- `validatePath()` should return the resolved canonical path.
- Callers should use `resolvedPath` for filesystem operations.
- This keeps the app and CLI aligned on one path representation.
