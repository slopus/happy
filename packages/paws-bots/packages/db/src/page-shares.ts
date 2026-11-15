import type { Prisma } from "./client.js";

/** A page link's sealed token: the secret row's id and the ref its secret store keeps it under. */
export type PageShareSecret = { id: string; ciphertext: string };

/**
 * A shared page keeps its link token sealed in a secret the page points to. Deleting pages any
 * way other than one at a time (their group going, for one) must delete those secrets first,
 * or the cascade leaves them behind with no page. Returns the deleted secrets, so that once the
 * transaction commits the caller can remove them from a remote secret store too.
 */
export async function deletePageShareSecrets(
  tx: Prisma.TransactionClient,
  pages: Prisma.PageWhereInput,
): Promise<PageShareSecret[]> {
  // Ends the links and locks the pages, so a link swap committing meanwhile is read here, and one
  // still to come waits and then finds its page gone, rather than slipping between read and delete.
  await tx.page.updateMany({
    where: pages,
    data: { visibility: "private", shareTokenHash: null },
  });
  const secrets = await tx.secret.findMany({
    where: { pageShare: { is: pages } },
    select: { id: true, ciphertext: true },
  });
  await tx.secret.deleteMany({ where: { id: { in: secrets.map((secret) => secret.id) } } });
  return secrets;
}
