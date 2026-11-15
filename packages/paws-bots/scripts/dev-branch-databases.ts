import { createHash } from "node:crypto";

export const BRANCH_DATABASE_COMMENT = "rakazo dev branch: ";

/** Keep database names safe as both SQL identifiers and local directory names. */
export function branchDatabaseName(sharedName: string, branch: string): string {
  const safeShared = sharedName.replace(/[^A-Za-z0-9_-]/g, "_");
  // Preserve existing names for ordinary databases; distinguish escaped shared names too.
  const identity = safeShared === sharedName ? branch : JSON.stringify([sharedName, branch]);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
  const readable = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefix = `${safeShared}_${readable}`.slice(0, 63 - hash.length - 1).replace(/_+$/, "");
  return `${prefix}_${hash}`;
}

/** Catalog comments alone must not authorize SQL or recursive filesystem deletion. */
export function branchDatabaseOwner(
  row: { owner: string; name: string },
  sharedName: string,
  repo: string,
): string | undefined {
  try {
    const owner = JSON.parse(row.owner);
    if (
      owner?.repo === repo &&
      typeof owner.branch === "string" &&
      row.name === branchDatabaseName(sharedName, owner.branch)
    )
      return owner.branch;
  } catch {
    // Unrecognized catalog metadata never names a database we may delete.
  }
  return undefined;
}
