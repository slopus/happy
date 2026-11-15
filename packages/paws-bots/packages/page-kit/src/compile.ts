import { transform } from "sucrase";

/** Page JSX to a CommonJS body. The save check compiles once and keeps the viewer code. */
export function compilePageSource(source: string): string {
  return transform(source, {
    transforms: ["jsx", "imports"],
    jsxRuntime: "classic",
    production: true,
    filePath: "page.jsx",
  }).code;
}

const SOURCES_PRAGMA = /^\uFEFF?\s*\/\*(?!\*)[ \t]*page-sources[ \t]*\r?\n([\s\S]*?)\*\//;

/**
 * A page may open with a comment declaring data sources: `/* page-sources` then a JSON object
 * of snapshots keyed by id. useSource reads them back; nothing refreshes them yet.
 */
export function declaredSources(source: string): string {
  const match = SOURCES_PRAGMA.exec(source);
  if (!match) return "";
  let declared: unknown;
  try {
    declared = JSON.parse(match[1]!);
  } catch {
    throw new Error("The page-sources comment at the top of the page is not valid JSON.");
  }
  return declared && typeof declared === "object" && !Array.isArray(declared)
    ? `globalThis.__rakazoPageSources=${JSON.stringify(declared)};`
    : "";
}

/**
 * The page as the viewer runs it, compiled here so the viewer ships without the compiler. Its
 * sources are declared on the first line, so error line numbers still match the source, and a
 * page that cannot compile becomes code that throws, which the viewer shows as the page's error.
 */
export function pageViewerCode(source: string, compiled?: string): string {
  try {
    return `"use strict";${declaredSources(source)}${compiled ?? compilePageSource(source)}`;
  } catch (error) {
    return `throw new Error(${JSON.stringify(error instanceof Error ? error.message : String(error))});`;
  }
}
