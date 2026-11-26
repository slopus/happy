/**
 * CSS.supports shim for tldraw's module-scope environment probe (#40).
 *
 * @tldraw/editor's tlenv initialization runs at import time and calls
 * CSS.supports("color", "color(display-p3 1 1 1)") guarded only by
 * `typeof CSS !== "undefined"`. Environments that expose a `CSS` global
 * without the `supports` method (embedded webviews with partial globals,
 * browsers predating the API) therefore throw "CSS.supports is not a
 * function" while DSH imports the client entry, which aborts the whole
 * plugin load - the image tools and gallery die together with the canvas.
 *
 * This module must be the first import of the client entry so it evaluates
 * before any tldraw code. It installs a conservative `supports()` returning
 * false only when the method is genuinely missing; modern browsers are
 * untouched (the probe already treats false as "no P3 / no backdrop filter",
 * which only downgrades the canvas color space, not the plugin).
 */

/** Install a fallback `supports` on a CSS-like object when the method is missing. */
export function ensureCssSupports(cssLike: { supports?: unknown }): void {
  if (typeof cssLike.supports !== 'function') {
    cssLike.supports = () => false
  }
}

if (typeof CSS !== 'undefined') {
  ensureCssSupports(CSS)
}
