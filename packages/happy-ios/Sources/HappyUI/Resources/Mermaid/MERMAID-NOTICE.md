# Mermaid

The chat draws ```` ```mermaid ```` blocks the way happy-app's
`MermaidRenderer.tsx` does on iOS: mermaid renders the diagram in a web page
(`ChatMermaidView`). happy-app loads mermaid from a CDN; this app ships it.

- `mermaid.min.js`: `dist/mermaid.min.js` from the npm package
  `mermaid@11.12.2`, the version happy-app's `pnpm-lock.yaml` resolves,
  unchanged. Its SRI digest (sha512) is
  `pMfvBKpWQkWCID8H+bisaGxxVlLfiDoBM0Skal8gc+vtOjCxEh0Hz5nfRoKoEaB8FwJcWx5Wp21MycoWu01uuw==`,
  as in the tarball's pnpm index. `MermaidBundleTests` checks it.
- `mermaid-LICENSE.txt`: the package's `LICENSE` (MIT, Knut Sveidqvist),
  unchanged. The notices of the libraries mermaid bundles (DOMPurify under
  Apache-2.0 or MPL-2.0, js-yaml, lodash-es and cytoscape under MIT) are in
  the script's closing "Bundled license information" comment, which is kept.
- `mermaid.html`: the page, ported from MermaidRenderer's native HTML. The
  diagram, the theme and the background come in as arguments to `render`
  (`callAsyncJavaScript`), never written into the markup.

To update, copy both files from the version happy-app's lockfile resolves,
then update the digests here and in `MermaidBundleTests`.
