import { matchesSearchQuery } from "./search.js";

/** Model and provider lists share the same search visibility rule. */
export const MODEL_SEARCH_THRESHOLD = 10;

export type ListSearchOptions<T> = {
  text: (item: T) => string | readonly (string | undefined)[];
  id?: (item: T) => string;
  selectedIds?: readonly string[];
  threshold?: number;
};

export function listSearch<T>(
  items: readonly T[],
  query: string,
  { text, id, selectedIds = [], threshold = MODEL_SEARCH_THRESHOLD }: ListSearchOptions<T>,
) {
  const active = query.trim().length > 0;
  const selected = new Set(selectedIds);
  let hiddenSelectedCount = 0;
  const visible = active
    ? items.filter((item) => {
        const fields = text(item);
        const matches = matchesSearchQuery(
          query,
          ...(typeof fields === "string" ? [fields] : fields),
        );
        if (!matches && id && selected.has(id(item))) hiddenSelectedCount += 1;
        return matches;
      })
    : items;
  return { showSearch: items.length > threshold || active, visible, hiddenSelectedCount };
}
