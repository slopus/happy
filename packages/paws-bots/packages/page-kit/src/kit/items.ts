/** The object items of a list prop; a page's data may hold anything else, or no list at all. */
export const objectItems = <T>(list: readonly T[] | undefined): T[] =>
  (Array.isArray(list) ? list : []).filter((item) => item && typeof item === "object");
