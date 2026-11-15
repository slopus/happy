function hasPrismaCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/** A unique constraint rejected the write (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return hasPrismaCode(error, "P2002");
}

/** A foreign key rejected the write (Prisma P2003). */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPrismaCode(error, "P2003");
}

/** The record an update or delete required does not exist (Prisma P2025). */
export function isRecordNotFound(error: unknown): boolean {
  return hasPrismaCode(error, "P2025");
}
