import { randomBytes } from "node:crypto";
import { signupPolicyFromEnv } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { isUniqueViolation } from "./prisma-errors.js";

export interface SignupPolicyEnv {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
}

type OrganizationClient = Pick<
  PrismaClient,
  "organization" | "member" | "space" | "spaceMember" | "memoryDocument" | "notificationPreference"
>;

function newId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * An organization owned by `userId`, with a default Space of the same id and name. Each step
 * joins an existing row instead of failing, so a concurrent call with the same slug converges.
 * Returns the organization's id, which is also its default Space's.
 */
export async function createOrganizationWithDefaultSpace(
  prisma: OrganizationClient,
  input: { userId: string; orgId: string; name: string; slug: string },
): Promise<string> {
  const { userId, name, slug } = input;
  let orgId = input.orgId;
  try {
    await prisma.organization.create({
      data: { id: orgId, name, slug, createdAt: new Date() },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    orgId = (await prisma.organization.findUniqueOrThrow({ where: { slug } })).id;
  }
  // Before the Space, so the trigger joining members to the default Space finds none and the
  // SpaceMember below cannot collide, which would abort a caller's transaction.
  await prisma.member
    .create({
      data: { id: newId(), organizationId: orgId, userId, role: "owner", createdAt: new Date() },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.space
    .create({
      data: {
        id: orgId,
        organizationId: orgId,
        name,
        isDefault: true,
        createdByUserId: userId,
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.spaceMember
    .create({
      data: {
        id: newId(),
        spaceId: orgId,
        organizationId: orgId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  const hasMemory = await prisma.memoryDocument.findFirst({
    where: { spaceId: orgId, userId, scope: "user", path: "MEMORY.md" },
  });
  if (!hasMemory) {
    await prisma.memoryDocument
      .create({
        data: {
          spaceId: orgId,
          userId,
          scope: "user",
          path: "MEMORY.md",
          content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
        },
      })
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
      });
  }
  await prisma.notificationPreference
    .create({ data: { spaceId: orgId, userId } })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  return orgId;
}

/** Provision a personal workspace. Signup never grants deployment administration. */
export async function bootstrapUserSpace(
  prisma: PrismaClient,
  user: { id: string },
  env: SignupPolicyEnv,
): Promise<{ spaceId: string }> {
  // Concurrent bootstraps for the same user (e.g. overlapping first phone inbounds) share the slug.
  const spaceId = await createOrganizationWithDefaultSpace(prisma, {
    userId: user.id,
    orgId: newId(),
    name: "Personal",
    slug: `user-${user.id.slice(0, 12)}`,
  });
  const policy = signupPolicyFromEnv(env);
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      ownerUserId: null,
      signupsEnabled: policy.enabled,
      signupAllowlist: policy.allowlist.join(","),
      signupPolicyInitialized: true,
    },
    update: {},
  });
  return { spaceId };
}
