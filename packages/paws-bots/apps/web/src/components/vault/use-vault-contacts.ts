import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query";
import type { BillingContact } from "./VaultItemEditor";

/** The saved contacts of the vault this Space uses, which a card can bill to. */
export function useVaultContacts(): BillingContact[] | undefined {
  const queries = useSpaceQueries();
  const { data } = useQuery(queries.vault.list.queryOptions({ input: {} }));
  return data?.flatMap((item) =>
    item.auth?.type === "contact" ? [{ name: item.name, title: item.title }] : [],
  );
}
