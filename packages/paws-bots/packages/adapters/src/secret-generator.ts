import { randomInt } from "node:crypto";
import type { GeneratedSecretRules } from "@rakazo/contracts";
import { GENERATED_SECRET_SYMBOLS } from "@rakazo/contracts";

/** A random password or key with at least one character from every allowed kind. */
export function generateSecretValue(rules: GeneratedSecretRules): string {
  const sets = [
    rules.lowercase && "abcdefghijklmnopqrstuvwxyz",
    rules.uppercase && "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    rules.digits && "0123456789",
    rules.symbols && (rules.allowedSymbols ?? GENERATED_SECRET_SYMBOLS),
  ].filter((set): set is string => Boolean(set));
  const all = sets.join("");
  const characters = sets.map(pick);
  while (characters.length < rules.length) characters.push(pick(all));
  // Fisher-Yates, so the required characters are not always first.
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [characters[index], characters[other]] = [characters[other]!, characters[index]!];
  }
  return characters.join("");
}

function pick(set: string): string {
  return set[randomInt(set.length)]!;
}
