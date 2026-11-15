/**
 * `message` as `catalog` translates it, or the message itself when the catalog lacks it, with
 * `{name}` placeholders filled from `values`. Catalogs are keyed by the English source text.
 */
export function translate(
  catalog: Readonly<Record<string, string>> | undefined,
  message: string,
  values?: Record<string, string | number>,
): string {
  const template = catalog && Object.hasOwn(catalog, message) ? catalog[message]! : message;
  if (!values) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
