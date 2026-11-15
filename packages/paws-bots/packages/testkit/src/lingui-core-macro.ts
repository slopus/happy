import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { i18n } from "@lingui/core";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";

/**
 * The Lingui macros compile away in the app build; tests run the source. These stand-ins render
 * the English text, and translate it through the loaded catalogs when the macro's message is known
 * at runtime. A plain `${value}` takes its name from the source variable, which a test cannot see,
 * so its message is found among the English catalog's ids by the text around it.
 */
type Descriptor = { id?: string; message?: string; values?: Record<string, unknown> };

const PLACEHOLDER = Symbol("placeholder");
type Placeholder = { [PLACEHOLDER]: true; name: string; value: unknown };

function isPlaceholder(value: unknown): value is Placeholder {
  return typeof value === "object" && value !== null && PLACEHOLDER in value;
}

/**
 * Next to this file when its URL is a file path; a browser-like test environment has none, so
 * then it is found from the working folder.
 */
function englishCatalog(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const file = path.join(path.dirname(here), "../../i18n/locales/en/messages.po");
    if (existsSync(file)) return file;
  } catch {
    // Not a file URL: search from the working folder below.
  }
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "packages/i18n/locales/en/messages.po");
    if (existsSync(file)) return file;
    if (path.dirname(dir) === dir) throw new Error("No English catalog above the working folder");
  }
}

let sourceIds: string[] | undefined;
function catalogIds(): string[] {
  sourceIds ??= [...readFileSync(englishCatalog(), "utf8").matchAll(/^msgid ((?:".*"\n?)+)/gm)].map(
    (match) =>
      match[1]!
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string)
        .join(""),
  );
  return sourceIds;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The catalog message a template with unnamed values compiles to, when only one fits. */
function sourceMessage(raw: readonly string[], args: unknown[]) {
  const pattern = new RegExp(
    `^${raw
      .map((part, index) => {
        const arg = args[index];
        const hole =
          index === raw.length - 1
            ? ""
            : isPlaceholder(arg)
              ? escapeRegExp(`{${arg.name}}`)
              : "\\{(\\w+)\\}";
        return escapeRegExp(part) + hole;
      })
      .join("")}$`,
  );
  const matches = catalogIds().filter((id) => pattern.test(id));
  if (matches.length !== 1) return null;
  const names = pattern.exec(matches[0]!)!.slice(1);
  const values: Record<string, unknown> = {};
  let plain = 0;
  args.forEach((arg) => {
    if (isPlaceholder(arg)) values[arg.name] = arg.value;
    else values[names[plain++]!] = arg;
  });
  return { message: matches[0]!, values };
}

function translate(message: string, values: Record<string, unknown>, fallback: string): string {
  if (!i18n.locale) return fallback;
  return i18n._({ id: generateMessageId(message), message, values });
}

function render(strings: TemplateStringsArray | Descriptor, args: unknown[]): string {
  if (!Array.isArray(strings)) {
    const descriptor = strings as Descriptor;
    const message = descriptor.message ?? descriptor.id ?? "";
    return translate(message, descriptor.values ?? {}, message);
  }
  const raw = strings as readonly string[];
  const english = String.raw(
    { raw },
    ...args.map((arg) => (isPlaceholder(arg) ? String(arg.value) : arg)),
  );
  if (args.some((arg) => !isPlaceholder(arg))) {
    const found = sourceMessage(raw, args);
    return found ? translate(found.message, found.values, english) : english;
  }
  const values: Record<string, unknown> = {};
  let message = raw[0] ?? "";
  args.forEach((arg, index) => {
    const placeholder = arg as Placeholder;
    values[placeholder.name] = placeholder.value;
    message += `{${placeholder.name}}${raw[index + 1] ?? ""}`;
  });
  return translate(message, values, english);
}

export function t(strings: TemplateStringsArray | Descriptor, ...args: unknown[]): string {
  return render(strings, args);
}

export function msg(strings: TemplateStringsArray, ...args: unknown[]) {
  const message = String.raw(
    { raw: strings as readonly string[] },
    ...args.map((arg) => (isPlaceholder(arg) ? `{${arg.name}}` : arg)),
  );
  return { id: generateMessageId(message), message };
}

export const defineMessage = msg;

export function ph(value: Record<string, unknown>): string {
  const [name, inner] = Object.entries(value)[0] ?? ["0", ""];
  // Typed as the macro's string; at runtime it carries its name for the message.
  return { [PLACEHOLDER]: true, name, value: inner } as unknown as string;
}

export function plural(count: number, forms: Record<string, string>): string {
  const form = forms[`=${count}`] ?? (count === 1 ? forms.one : undefined) ?? forms.other ?? "";
  return form.replace(/#/g, String(count));
}
