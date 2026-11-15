import { i18n } from "@lingui/core";

// Preserve the existing macro-generated catalog IDs without requiring macro compilation here.
export function botRemovalWarning(groups: readonly { name: string }[] | null): string {
  if (groups === null)
    return i18n._({
      id: "oHABLZ",
      message:
        "Groups left with fewer than two bots are deleted too, including their messages, files, and pages.",
    });
  if (groups.length === 0) return "";
  const names = groups.map((group) => group.name).join(", ");
  return groups.length === 1
    ? i18n._({
        id: "TNdf-N",
        message: "The group {names} will be deleted too, including its messages, files, and pages.",
        values: { names },
      })
    : i18n._({
        id: "N8SrqH",
        message:
          "The groups {names} will be deleted too, including their messages, files, and pages.",
        values: { names },
      });
}
