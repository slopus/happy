import { readFileSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { ResolvedAppearance, WebColorTokens } from "@rakazo/ui-tokens";
import { cssVariableName, webDarkTokens } from "@rakazo/ui-tokens";

export const INSTANCE_THEME_PATH = "/instance-theme.css";
const FONT_PATH = "/instance-theme/font/";

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Font stacks only: names, quotes, commas and spaces. No url(), braces or semicolons.
const FONT_STACK = /^[\w\s"',-]+$/;
const FAMILY = /^[\w -]+$/;
const WEIGHT = /^\d{3}(?: \d{3})?$/;
const LENGTH = /^\d+(?:\.\d+)?(?:px|rem)$/;
const FONT_TYPES: Record<string, { format: string; mime: string }> = {
  ".woff2": { format: "woff2", mime: "font/woff2" },
  ".woff": { format: "woff", mime: "font/woff" },
  ".ttf": { format: "truetype", mime: "font/ttf" },
  ".otf": { format: "opentype", mime: "font/otf" },
};

type Overlay = Partial<Record<keyof WebColorTokens, string>>;

/** A font file the instance serves itself, so the app's `font-src 'self'` still holds. */
type FontFile = { family: string; file: string; weight?: string };

export type InstanceTheme = {
  dark: Overlay;
  light: Overlay;
  fonts: { sans?: string; mono?: string; files: FontFile[] };
  /** The base corner size; the `rounded-sm` to `rounded-2xl` scale is derived from it. */
  radius?: string;
};

function readOverlay(value: unknown, where: string): Overlay {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") throw new Error(`${where} must be an object`);
  const overlay: Overlay = {};
  for (const [key, color] of Object.entries(value)) {
    if (!Object.hasOwn(webDarkTokens, key)) throw new Error(`${where}.${key} is not a token`);
    if (typeof color !== "string" || !COLOR.test(color)) {
      throw new Error(`${where}.${key} must be a hex color`);
    }
    overlay[key as keyof WebColorTokens] = color;
  }
  return overlay;
}

function readFont(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !FONT_STACK.test(value)) {
    throw new Error(`${where} must be a font-family list`);
  }
  return value;
}

/** Font files resolve against the theme file's folder, so a theme and its fonts mount together. */
function readFontFiles(value: unknown, themeDir: string): FontFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("fonts.files must be a list");
  return value.map((entry: unknown, index) => {
    const where = `fonts.files[${index}]`;
    const { family, file, weight } = (entry ?? {}) as Record<string, unknown>;
    if (typeof family !== "string" || !FAMILY.test(family)) {
      throw new Error(`${where}.family must be a font name`);
    }
    if (typeof file !== "string" || !FONT_TYPES[path.extname(file).toLowerCase()]) {
      throw new Error(`${where}.file must be a .woff2, .woff, .ttf or .otf file`);
    }
    if (weight !== undefined && (typeof weight !== "string" || !WEIGHT.test(weight))) {
      throw new Error(`${where}.weight must look like "400" or "100 900"`);
    }
    const resolved = path.resolve(themeDir, file);
    if (path.isAbsolute(file) || !inside(themeDir, resolved)) {
      throw new Error(`${where}.file must be inside the theme's folder`);
    }
    return { family, file: resolved, weight };
  });
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative !== "" && !escapes && !path.isAbsolute(relative);
}

export function parseInstanceTheme(source: string, themeDir: string): InstanceTheme {
  const raw: unknown = JSON.parse(source);
  if (!raw || typeof raw !== "object") throw new Error("theme must be an object");
  const { dark, light, fonts, radius, ...rest } = raw as Record<string, unknown>;
  const unknownKey = Object.keys(rest)[0];
  if (unknownKey) throw new Error(`${unknownKey} is not a theme field`);
  const fontObject = (fonts ?? {}) as Record<string, unknown>;
  if (radius !== undefined && (typeof radius !== "string" || !LENGTH.test(radius))) {
    throw new Error('radius must look like "12px" or "0.5rem"');
  }
  return {
    dark: readOverlay(dark, "dark"),
    light: readOverlay(light, "light"),
    fonts: {
      sans: readFont(fontObject.sans, "fonts.sans"),
      mono: readFont(fontObject.mono, "fonts.mono"),
      files: readFontFiles(fontObject.files, themeDir),
    },
    radius,
  };
}

function block(selector: string, lines: string[]): string {
  return lines.length ? `${selector} {\n${lines.join("\n")}\n}` : "";
}

function colorLines(overlay: Overlay): string[] {
  return (Object.keys(overlay) as (keyof WebColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${overlay[token]};`,
  );
}

function fontFace(font: FontFile, index: number): string {
  const ext = path.extname(font.file).toLowerCase();
  return block("@font-face", [
    `  font-family: "${font.family}";`,
    `  src: url("${FONT_PATH}${index}${ext}") format("${FONT_TYPES[ext]?.format}");`,
    ...(font.weight ? [`  font-weight: ${font.weight};`] : []),
    "  font-display: swap;",
  ]);
}

/** Loaded after the app stylesheet; `html[...]` outranks the token blocks' `:root, [data-theme]`. */
export function renderInstanceThemeCss(theme: InstanceTheme): string {
  const appearances: ResolvedAppearance[] = ["dark", "light"];
  const root = [
    theme.fonts.sans && `  --font-sans: ${theme.fonts.sans};`,
    theme.fonts.mono && `  --font-mono: ${theme.fonts.mono};`,
    theme.radius && `  --radius: ${theme.radius};`,
  ].filter((line): line is string => Boolean(line));
  return [
    ...theme.fonts.files.map(fontFace),
    block("html:root", root),
    ...appearances.map((appearance) =>
      block(`html[data-theme="${appearance}"]`, colorLines(theme[appearance])),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Links the theme after the app's own head, so instances without one make no extra request. */
export function withInstanceThemeLink(html: string): string {
  return html.replace(
    "</head>",
    `  <link rel="stylesheet" href="${INSTANCE_THEME_PATH}" />\n  </head>`,
  );
}

/**
 * The built page with the theme linked, for `vite preview`. Runs after Vite's SPA fallback has
 * rewritten the request to `/index.html`, so it answers exactly the requests that get the app.
 */
export function instanceThemeIndexMiddleware(outDir: string) {
  const html = withInstanceThemeLink(readFileSync(path.join(outDir, "index.html"), "utf8"));
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split("?", 1)[0] !== "/index.html" || req.headers["sec-fetch-dest"] === "script") {
      return next();
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.end(req.method === "HEAD" ? undefined : html);
  };
}

function loadTheme(file: string): InstanceTheme {
  return parseInstanceTheme(readFileSync(file, "utf8"), path.dirname(path.resolve(file)));
}

/**
 * Serves `RAKAZO_THEME`'s stylesheet and font files. The file is re-read per request so a
 * self-hoster sees edits on reload; a bad file is logged and serves nothing.
 */
export function instanceThemeMiddleware(themeFile: string, warn: (reason: string) => void) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = req.url?.split("?", 1)[0] ?? "";
    if (pathname === INSTANCE_THEME_PATH) {
      res.setHeader("content-type", "text/css; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      let css = "";
      try {
        css = renderInstanceThemeCss(loadTheme(themeFile));
      } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
      }
      res.end(css);
      return;
    }
    if (!pathname.startsWith(FONT_PATH)) return next();
    // Only indexes into the theme's own list are served, never a path from the URL.
    const index = Number.parseInt(pathname.slice(FONT_PATH.length), 10);
    try {
      const font = loadTheme(themeFile).fonts.files[index];
      if (!font) return next();
      // A symlink in the theme folder must not reach outside it either.
      const themeDir = realpathSync(path.dirname(path.resolve(themeFile)));
      const real = realpathSync(font.file);
      if (!inside(themeDir, real)) throw new Error(`${font.file} is outside the theme's folder`);
      const body = readFileSync(real);
      res.setHeader("content-type", FONT_TYPES[path.extname(font.file).toLowerCase()]?.mime ?? "");
      res.setHeader("cache-control", "no-cache");
      res.end(body);
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));
      next();
    }
  };
}
