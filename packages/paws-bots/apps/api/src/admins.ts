import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

type AdminDeps = Pick<RouterDeps, "prisma"> & { env: Pick<RouterDeps["env"], "adminEmails"> };

/** Accounts listed in RAKAZO_ADMIN_EMAILS, once their email is verified. */
export async function isAdmin(deps: AdminDeps, userId: string): Promise<boolean> {
  const admins = deps.env.adminEmails ?? [];
  if (admins.length === 0) return false;
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return Boolean(user?.emailVerified && admins.includes(user.email.toLowerCase()));
}

export async function requireAdmin(deps: AdminDeps, userId: string): Promise<void> {
  if (!(await isAdmin(deps, userId))) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
}
