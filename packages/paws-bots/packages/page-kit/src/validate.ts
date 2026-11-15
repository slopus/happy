/// <reference path="./sucrase-parser.d.ts" />
import { PAGE_SOURCE_MAX_BYTES, pageSourceBytes } from "@rakazo/contracts";
// Sucrase's own parser, pinned with it, so the check reads the same tokens the compiler does.
import { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { compilePageSource, declaredSources, pageViewerCode } from "./compile.js";
import {
  PAGE_GLOBALS,
  PAGE_HELPERS,
  PAGE_KIT_COMPONENTS,
  PAGE_KIT_MODULE,
  PAGE_MODULES,
} from "./components.js";
import { selfRenderingKitNames, selfRenderingMessage } from "./shadow.js";

export { PAGE_KIT_GUIDE } from "./guide.js";

const MAX_REPORTED_ERRORS = 20;

/**
 * A page that passes carries its viewer code, compiled once here and stored with the version.
 * Warnings do not stop the save; they tell the bot about text the reader would see verbatim.
 */
type PageSourceCheck =
  | { ok: true; code: string; warnings?: string[] }
  | { ok: false; errors: string[] };

const KIT_NAMES: ReadonlySet<string> = new Set(PAGE_KIT_COMPONENTS);
// Built once; the kit is long enough that the checker gives up on joining the literal tuple.
const KIT_LIST = (PAGE_KIT_COMPONENTS as readonly string[]).join(", ");
// Escapes JSX decodes in its own text, but that a JavaScript string shows as typed.
const HTML_ENTITY = /&(?:lt|gt|amp|quot|apos|nbsp|#39|#x27);/;

/** React hooks a page may call. A hook called while the file loads runs outside React's render. */
const REACT_HOOKS: ReadonlySet<string> = new Set([
  "useCallback",
  "useContext",
  "useDebugValue",
  "useDeferredValue",
  "useEffect",
  "useId",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
  "useReducer",
  "useRef",
  "useSource",
  "useState",
  "useSyncExternalStore",
  "useTheme",
  "useTransition",
]);
// A hook React adds later still looks like this, so the shape catches it too.
const HOOK_NAME = /^use[A-Z][A-Za-z0-9]*$/;

const GIVEN: ReadonlySet<string> = new Set(PAGE_GLOBALS);
const DECLARATION_ROLES: ReadonlySet<IdentifierRole | null> = new Set([
  IdentifierRole.TopLevelDeclaration,
  IdentifierRole.FunctionScopedDeclaration,
  IdentifierRole.BlockScopedDeclaration,
  IdentifierRole.ObjectShorthandTopLevelDeclaration,
  IdentifierRole.ObjectShorthandFunctionScopedDeclaration,
  IdentifierRole.ObjectShorthandBlockScopedDeclaration,
  IdentifierRole.ImportDeclaration,
]);

/**
 * Catches mistakes before the user sees the page, with line numbers the bot can act on. It is
 * not a security boundary: page code runs only inside the sandboxed viewer, which is the boundary.
 */
export function checkPageSource(source: string): PageSourceCheck {
  const bytes = pageSourceBytes(source);
  if (bytes > PAGE_SOURCE_MAX_BYTES) {
    return {
      ok: false,
      errors: [
        `The page is ${bytes} bytes; the limit is ${PAGE_SOURCE_MAX_BYTES}. Move data out or split the page.`,
      ],
    };
  }
  const lineOf = lineLocator(source);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(source, true, false, false);
  } catch (error) {
    return { ok: false, errors: [syntaxErrorText(error)] };
  }
  const { tokens, scopes } = parsed;
  const errors: string[] = [];
  const warnings: string[] = [];
  const declared = new Set<string>();
  const tags = new Map<string, number>();
  let defaults = 0;
  const blocked = new Set<string>();
  tokens.forEach((token, index) => {
    const text = source.slice(token.start, token.end);
    const line = lineOf(token.start);
    if (token.type === TokenType._import) {
      const problem = importProblem(tokens, index, source);
      if (problem) errors.push(`line ${line}: ${problem}`);
    } else if (
      (token.type === TokenType.string || token.type === TokenType.template) &&
      !isJsxAttributeValue(tokens, index) &&
      HTML_ENTITY.test(text)
    ) {
      warnings.push(
        `line ${line}: ${text.match(HTML_ENTITY)![0]} in a JavaScript string shows up literally; write the plain character instead.`,
      );
    } else if (token.type === TokenType._export) {
      if (tokens[index + 1]?.type === TokenType._default) defaults += 1;
      else if (
        tokens[index + 1]?.type === TokenType.braceL &&
        exportsOnlyDefault(tokens, index + 1, source)
      )
        defaults += 1;
      else errors.push(`line ${line}: only \`export default\` is allowed.`);
    } else if (token.type === TokenType.jsxTagStart) {
      const nameToken =
        tokens[index + 1]?.type === TokenType.jsxName ? tokens[index + 1] : undefined;
      const name = nameToken ? source.slice(nameToken.start, nameToken.end) : "";
      // A lowercase first letter makes an element, and HTML reads its name in any case.
      const element = /^[a-z]/.test(name) ? name.toLowerCase() : "";
      if (BLOCKED_ELEMENTS.has(element) && !blocked.has(element)) {
        blocked.add(element);
        errors.push(
          `line ${line}: <${name}> is not allowed in a page; ${BLOCKED_ELEMENTS.get(element)}`,
        );
      }
    } else if (
      token.type === TokenType.jsxName &&
      /^on[a-z]/i.test(text) &&
      tokens[index + 1]?.type === TokenType.eq &&
      tokens[index + 2]?.type === TokenType.string
    ) {
      errors.push(
        `line ${line}: ${text} takes a function, not a string: write ${text}={() => ...}.`,
      );
    } else if (token.type === TokenType.name && DECLARATION_ROLES.has(token.identifierRole)) {
      declared.add(text);
    } else if (
      token.type === TokenType.name &&
      text === "require" &&
      token.identifierRole === IdentifierRole.Access
    ) {
      errors.push(
        `line ${line}: require is not available; everything a page can use is already in scope.`,
      );
    } else if (
      token.type === TokenType.jsxName &&
      token.identifierRole === IdentifierRole.Access &&
      !tags.has(text)
    ) {
      tags.set(text, line);
    } else if (
      // Compiled pages call React.createElement(Name, ...) where JSX would write <Name>.
      token.type === TokenType.name &&
      text === "createElement" &&
      tokens[index + 1]?.type === TokenType.parenL &&
      tokens[index + 2]?.type === TokenType.name &&
      tokens[index + 3]?.type !== TokenType.dot
    ) {
      const name = source.slice(tokens[index + 2]!.start, tokens[index + 2]!.end);
      if (/^[A-Z]/.test(name) && !tags.has(name)) tags.set(name, lineOf(tokens[index + 2]!.start));
    } else if (
      // createElement("iframe") makes the same element <iframe> would.
      token.type === TokenType.name &&
      text === "createElement" &&
      tokens[index + 1]?.type === TokenType.parenL &&
      tokens[index + 2]?.type === TokenType.string
    ) {
      const name = source.slice(tokens[index + 2]!.start + 1, tokens[index + 2]!.end - 1);
      const element = name.toLowerCase();
      if (BLOCKED_ELEMENTS.has(element) && !blocked.has(element)) {
        blocked.add(element);
        errors.push(
          `line ${line}: <${name}> is not allowed in a page; ${BLOCKED_ELEMENTS.get(element)}`,
        );
      }
    }
  });
  for (const { name, start } of selfRenderingKitNames(tokens, source)) {
    errors.push(`line ${lineOf(start)}: ${selfRenderingMessage(name)}`);
  }
  for (const [name, line] of tags) {
    if (GIVEN.has(name) || declared.has(name)) continue;
    errors.push(
      `line ${line}: <${name}> is not a kit component. Use ${KIT_LIST}, or define ${name} in this file.`,
    );
  }
  for (const { name, start } of moduleScopeHookCalls(tokens, scopes, source, declared)) {
    errors.push(
      `line ${lineOf(start)}: ${name}() must be called inside a component, not at the top level of the file.`,
    );
  }
  if (defaults !== 1) {
    errors.push("The page needs exactly one `export default` of its top component.");
  }
  // The list goes back to the model, so a file with the same mistake on every line stays cheap.
  if (errors.length > MAX_REPORTED_ERRORS) {
    const more = errors.length - MAX_REPORTED_ERRORS;
    return { ok: false, errors: [...errors.slice(0, MAX_REPORTED_ERRORS), `…and ${more} more.`] };
  }
  if (errors.length) return { ok: false, errors };
  let compiled: string;
  try {
    declaredSources(source);
    compiled = compilePageSource(source);
  } catch (error) {
    return { ok: false, errors: [syntaxErrorText(error)] };
  }
  const code = pageViewerCode(source, compiled);
  return warnings.length
    ? { ok: true, code, warnings: warnings.slice(0, MAX_REPORTED_ERRORS) }
    : { ok: true, code };
}

type Tokens = ReturnType<typeof parse>["tokens"];

// Plain HTML and SVG elements are fine for custom visuals; these would load or run something
// else, which the viewer's sandbox blocks anyway, so the page would show a hole.
const BLOCKED_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ["script", "page code runs from the file itself."],
  ["style", "use style={{...}} on the element or the kit's components."],
  ["iframe", "pages cannot embed other pages."],
  ["object", "pages cannot embed other content."],
  ["embed", "pages cannot embed other content."],
  ["foreignobject", "draw with SVG shapes and text instead."],
]);

/** \`export { App as default }\`, as bundlers write it, names the default export and nothing else. */
function exportsOnlyDefault(tokens: Tokens, open: number, source: string): boolean {
  const words: string[] = [];
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === TokenType.braceR) {
      return words.length === 3 && words[1] === "as" && words[2] === "default";
    }
    words.push(source.slice(token.start, token.end));
  }
  return false;
}

/** An import of React or the kit is allowed and changes nothing; anything else cannot load. */
function importProblem(tokens: Tokens, start: number, source: string): string | undefined {
  const text = (index: number) => source.slice(tokens[index]!.start, tokens[index]!.end);
  let index = start + 1;
  const names: string[] = [];
  let hasDefault = false;
  let inBraces = false;
  for (; index < tokens.length && tokens[index]!.type !== TokenType.string; index++) {
    const type = tokens[index]!.type;
    if (type === TokenType.parenL || type === TokenType.dot) break;
    if (type === TokenType.braceL) inBraces = true;
    else if (type === TokenType.braceR) inBraces = false;
    else if (type === TokenType.name && inBraces && text(index - 1) !== "as")
      names.push(text(index));
    else if (type === TokenType.name && !inBraces && !["from", "as"].includes(text(index))) {
      // A namespace import ("* as Kit") is fine; a bare name is a default import.
      if (text(index - 1) !== "as") hasDefault = true;
    }
  }
  const from = tokens[index]?.type === TokenType.string ? text(index).slice(1, -1) : undefined;
  if (from === undefined || !PAGE_MODULES.has(from)) {
    return `only "react" and "${PAGE_KIT_MODULE}" can be imported, and neither is needed: the kit components, React and its hooks are already in scope.`;
  }
  if (from !== PAGE_KIT_MODULE) return undefined;
  if (hasDefault) return `"${PAGE_KIT_MODULE}" has no default export; import components by name.`;
  const unknown = names.filter(
    (name) =>
      name !== "as" &&
      !KIT_NAMES.has(name) &&
      !PAGE_HELPERS.includes(name as (typeof PAGE_HELPERS)[number]),
  );
  return unknown.length
    ? `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} not in the kit. Use ${KIT_LIST}.`
    : undefined;
}

function isJsxAttributeValue(tokens: Tokens, index: number): boolean {
  return tokens[index - 1]?.type === TokenType.eq && tokens[index - 2]?.type === TokenType.jsxName;
}

function syntaxErrorText(error: unknown): string {
  const loc = (error as { loc?: { line: number; column: number } }).loc;
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /\s*\(\d+:\d+\)$/,
    "",
  );
  return loc ? `line ${loc.line}, column ${loc.column + 1}: ${message}` : message;
}

function lineLocator(source: string): (offset: number) => number {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * A hook called while the file is loading runs outside React's render, where the dispatcher is
 * null, so the viewer crashes on it. Finds the calls that sit at the top level of the file.
 */
function moduleScopeHookCalls(
  tokens: Tokens,
  scopes: ReturnType<typeof parse>["scopes"],
  source: string,
  declared: ReadonlySet<string>,
): { name: string; start: number }[] {
  const found: { name: string; start: number }[] = [];
  // Sucrase already records exact function ranges, including concise arrows and ASI.
  // Range deltas make membership linear even for many nested or adjacent functions.
  const boundaries = new Int32Array(tokens.length + 1);
  // The parser appends the file's own scope last; it does not defer execution.
  for (let index = 0; index < scopes.length - 1; index++) {
    const scope = scopes[index]!;
    if (!scope.isFunctionScope) continue;
    boundaries[scope.startTokenIndex]! += 1;
    boundaries[scope.endTokenIndex]! -= 1;
  }
  let functions = 0;
  const text = (index: number) => source.slice(tokens[index]!.start, tokens[index]!.end);
  for (let index = 0; index < tokens.length; index++) {
    functions += boundaries[index]!;
    const token = tokens[index]!;
    if (token.type !== TokenType.name) continue;
    const name = text(index);
    if (!isHookName(name, declared)) continue;
    // A hook that is only referenced is not a call.
    if (tokens[index + 1]?.type !== TokenType.parenL) continue;
    const before = tokens[index - 1];
    // A property, a definition or a constructor is not a call either.
    if (
      before &&
      (before.type === TokenType.dot ||
        before.type === TokenType.questionDot ||
        before.type === TokenType._function ||
        before.type === TokenType._class ||
        before.type === TokenType._new)
    )
      continue;
    // Inside a function body or an arrow body the hook runs while React renders.
    if (functions > 0) continue;
    found.push({ name, start: token.start });
  }
  return found;
}

/** A hook React may add later still looks like this; a page's own name does not have to. */
function isHookName(name: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(name)) return false;
  return REACT_HOOKS.has(name) || HOOK_NAME.test(name);
}
