/// <reference path="./sucrase-parser.d.ts" />
import type { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { PAGE_KIT_COMPONENTS } from "./components.js";

type Tokens = ReturnType<typeof parse>["tokens"];

const KIT: ReadonlySet<string> = new Set(PAGE_KIT_COMPONENTS);

/**
 * Top-level components named like a kit component that use that name inside themselves. The
 * page's own `Status` replaces the kit's in the whole file, so `<Status>` inside it renders
 * itself forever and hangs the viewer. Reusing a name without using it inside is harmless.
 */
export function selfRenderingKitNames(
  tokens: Tokens,
  source: string,
): { name: string; start: number }[] {
  const found: { name: string; start: number }[] = [];
  const text = (index: number) => source.slice(tokens[index]!.start, tokens[index]!.end);
  tokens.forEach((token, index) => {
    if (
      token.type !== TokenType.name ||
      token.identifierRole !== IdentifierRole.TopLevelDeclaration
    )
      return;
    const name = text(index);
    if (!KIT.has(name) || found.some((entry) => entry.name === name)) return;
    // Exports also end the scan: an anonymous default export has no declaration name.
    for (let at = index + 1; at < tokens.length; at++) {
      const next = tokens[at]!;
      if (
        next.identifierRole === IdentifierRole.TopLevelDeclaration ||
        next.type === TokenType._export
      )
        break;
      const used =
        (next.type === TokenType.jsxName && tokens[at - 1]?.type === TokenType.jsxTagStart) ||
        (next.type === TokenType.name &&
          text(at - 1) === "(" &&
          tokens[at - 2] !== undefined &&
          text(at - 2) === "createElement");
      if (used && text(at) === name) {
        found.push({ name, start: token.start });
        break;
      }
    }
  });
  return found;
}

export function selfRenderingMessage(name: string): string {
  return `your own \`${name}\` replaces the kit's ${name} in this file, so the <${name}> inside it renders itself forever. Rename yours, for example ${name}View.`;
}
