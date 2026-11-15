import { canonicalPiProviderId, storedPiProviderIds, usableModelId } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export const newestCredentialOrder = [
  { updatedAt: "desc" as const },
  { createdAt: "desc" as const },
  { id: "desc" as const },
];

export const newestModelCredentialOrder = newestCredentialOrder;

export function modelCredentialProviderFilter(provider: string): string | { in: string[] } {
  const ids = storedPiProviderIds(provider);
  return ids.length === 1 ? provider : { in: ids };
}

type ModelCredentialScope = { userId: string };

/** Stores a connection's own model choice, which it keeps in every Space; roles hold the rest. */
export function saveModelPreference(
  prisma: Pick<PrismaClient, "userModelPreference">,
  scope: ModelCredentialScope,
  credentialId: string,
  modelId: string | null | undefined,
  thinkingLevel?: string | null,
) {
  const persistedModelId = usableModelId(modelId);
  return prisma.userModelPreference.upsert({
    where: { userId_credentialId: { userId: scope.userId, credentialId } },
    create: {
      userId: scope.userId,
      credentialId,
      modelId: persistedModelId,
      thinkingLevel: thinkingLevel ?? null,
    },
    update: { modelId: persistedModelId, thinkingLevel: thinkingLevel ?? null },
  });
}

function withModelPreference<
  T extends {
    credential: {
      id: string;
      userId: string;
      provider: string;
      label: string;
      secretId: string;
      createdAt: Date;
      updatedAt: Date;
    };
    modelId: string | null;
    thinkingLevel: string | null;
  },
>(preference: T) {
  return {
    ...preference.credential,
    defaultModel: usableModelId(preference.modelId),
    thinkingLevel: preference.thinkingLevel,
  };
}

export function findNewestUserModelCredential(
  prisma: Pick<PrismaClient, "userModelCredential">,
  userId: string,
  provider: string,
) {
  return prisma.userModelCredential.findFirst({
    where: { userId, provider: modelCredentialProviderFilter(provider) },
    orderBy: newestModelCredentialOrder,
  });
}

type OrderedCredential = {
  id: string;
  provider: string;
  updatedAt: Date;
  createdAt: Date;
};

type OrderedPreference<C extends OrderedCredential> = {
  modelId: string | null;
  thinkingLevel: string | null;
  updatedAt: Date;
  credential: C;
};

function compareDescendingId(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

/** Most recently saved first. */
export function comparePreferenceOrder(
  left: { credentialId: string; updatedAt: Date },
  right: { credentialId: string; updatedAt: Date },
) {
  const updated = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updated !== 0) return updated;
  return compareDescendingId(left.credentialId, right.credentialId);
}

function compareOrderedPreference(
  left: OrderedPreference<OrderedCredential>,
  right: OrderedPreference<OrderedCredential>,
) {
  return comparePreferenceOrder(
    { credentialId: left.credential.id, updatedAt: left.updatedAt },
    { credentialId: right.credential.id, updatedAt: right.updatedAt },
  );
}

function compareCredentialOrder(left: OrderedCredential, right: OrderedCredential) {
  const updated = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updated !== 0) return updated;
  const created = right.createdAt.getTime() - left.createdAt.getTime();
  if (created !== 0) return created;
  return compareDescendingId(left.id, right.id);
}

/**
 * Credential a save or run would use for this provider and model.
 * A preference whose model id matches wins, then the provider preference
 * (most recently saved first), then the newest account credential. Unreadable secrets are not skipped.
 */
export function chooseModelCredential<C extends OrderedCredential>(input: {
  provider: string;
  modelId?: string | null;
  preferences: Array<OrderedPreference<C>>;
  credentials: C[];
}):
  | { source: "preference"; preference: OrderedPreference<C> }
  | { source: "credential"; credential: C }
  | null {
  const requestedModelId = usableModelId(input.modelId);
  const preferences = input.preferences
    .filter(
      (preference) =>
        canonicalPiProviderId(preference.credential.provider) ===
        canonicalPiProviderId(input.provider),
    )
    .sort(compareOrderedPreference);
  if (requestedModelId) {
    const matching = preferences.find((preference) => preference.modelId === requestedModelId);
    if (matching) return { source: "preference", preference: matching };
  }
  const providerPreference = preferences[0];
  if (providerPreference) return { source: "preference", preference: providerPreference };
  const credential = input.credentials
    .filter(
      (item) => canonicalPiProviderId(item.provider) === canonicalPiProviderId(input.provider),
    )
    .sort(compareCredentialOrder)[0];
  return credential ? { source: "credential", credential } : null;
}

function appendCredential<C extends OrderedCredential>(
  target: C[],
  seen: Set<string>,
  credential: C,
) {
  if (seen.has(credential.id)) return;
  seen.add(credential.id);
  target.push(credential);
}

/**
 * Credentials to try when saving a main model, best first.
 * The preference that already owns the model is the only candidate.
 * Otherwise the latest preference comes first, ahead of a newer unused account.
 */
export function defaultModelCredentialCandidates<C extends OrderedCredential>(input: {
  provider: string;
  modelId?: string | null;
  preferences: Array<OrderedPreference<C>>;
  credentials: C[];
}): C[] {
  const requestedModelId = usableModelId(input.modelId);
  const preferences = input.preferences
    .filter(
      (preference) =>
        canonicalPiProviderId(preference.credential.provider) ===
        canonicalPiProviderId(input.provider),
    )
    .sort(compareOrderedPreference);
  const credentials = input.credentials
    .filter(
      (credential) =>
        canonicalPiProviderId(credential.provider) === canonicalPiProviderId(input.provider),
    )
    .sort(compareCredentialOrder);

  if (requestedModelId) {
    const seen = new Set<string>();
    const owners: C[] = [];
    for (const preference of preferences) {
      if (usableModelId(preference.modelId) !== requestedModelId) continue;
      appendCredential(owners, seen, preference.credential);
    }
    if (owners.length > 0) return owners;
  }

  const latestPreference = preferences[0]?.credential;
  const preferenceByCredentialId = new Map(
    preferences.map((preference) => [preference.credential.id, preference]),
  );
  const replacesSavedModel = (credentialId: string) => {
    const owned = usableModelId(preferenceByCredentialId.get(credentialId)?.modelId);
    return owned !== null && owned !== requestedModelId;
  };
  const seen = new Set<string>();
  const open: C[] = [];
  const replacing: C[] = [];
  const add = (credential: C) => {
    if (latestPreference && credential.id === latestPreference.id) return;
    appendCredential(replacesSavedModel(credential.id) ? replacing : open, seen, credential);
  };
  for (const preference of preferences) add(preference.credential);
  for (const credential of credentials) add(credential);

  const ordered: C[] = [];
  const picked = new Set<string>();
  if (latestPreference) appendCredential(ordered, picked, latestPreference);
  for (const credential of open) appendCredential(ordered, picked, credential);
  for (const credential of replacing) appendCredential(ordered, picked, credential);
  return ordered;
}

function credentialFromChoice<
  C extends OrderedCredential & {
    userId: string;
    label: string;
    secretId: string;
  },
>(choice: ReturnType<typeof chooseModelCredential<C>>) {
  if (!choice) return null;
  if (choice.source === "preference") return withModelPreference(choice.preference);
  return { ...choice.credential, defaultModel: null, thinkingLevel: null };
}

export async function findModelCredential(
  prisma: Pick<PrismaClient, "userModelPreference" | "userModelCredential">,
  scope: ModelCredentialScope,
  provider: string,
  modelId?: string | null,
) {
  if (
    typeof prisma.userModelPreference.findMany === "function" &&
    typeof prisma.userModelCredential.findMany === "function"
  ) {
    const [preferences, credentials] = await Promise.all([
      prisma.userModelPreference.findMany({
        where: {
          userId: scope.userId,
          credential: { provider: modelCredentialProviderFilter(provider) },
        },
        include: { credential: true },
      }),
      prisma.userModelCredential.findMany({
        where: { userId: scope.userId, provider: modelCredentialProviderFilter(provider) },
      }),
    ]);
    return credentialFromChoice(
      chooseModelCredential({ provider, modelId, preferences, credentials }),
    );
  }

  const requestedModelId = usableModelId(modelId);
  // When a helper or bot selects a free-form model, prefer the preference that owns
  // that modelId so runtime uses the same credential the picker advertised.
  if (requestedModelId) {
    const matching = await prisma.userModelPreference.findFirst({
      where: {
        userId: scope.userId,
        modelId: requestedModelId,
        credential: { provider: modelCredentialProviderFilter(provider) },
      },
      include: { credential: true },
      orderBy: [{ updatedAt: "desc" }, { credentialId: "desc" }],
    });
    if (matching) {
      return credentialFromChoice(
        chooseModelCredential({ provider, modelId, preferences: [matching], credentials: [] }),
      );
    }
  }
  const preference = await prisma.userModelPreference.findFirst({
    where: {
      userId: scope.userId,
      credential: { provider: modelCredentialProviderFilter(provider) },
    },
    include: { credential: true },
    orderBy: [{ updatedAt: "desc" }, { credentialId: "desc" }],
  });
  if (preference) {
    return credentialFromChoice(
      chooseModelCredential({ provider, modelId, preferences: [preference], credentials: [] }),
    );
  }
  const credential = await findNewestUserModelCredential(prisma, scope.userId, provider);
  return credentialFromChoice(
    chooseModelCredential({
      provider,
      modelId,
      preferences: [],
      credentials: credential ? [credential] : [],
    }),
  );
}

/** One connection by id, with its own model; null when it is gone. */
export async function findModelCredentialById(
  prisma: Pick<PrismaClient, "userModelCredential">,
  scope: ModelCredentialScope,
  credentialId: string,
  provider?: string,
) {
  const credential = await prisma.userModelCredential.findFirst({
    where: {
      id: credentialId,
      userId: scope.userId,
      ...(provider ? { provider: modelCredentialProviderFilter(provider) } : {}),
    },
    include: { userPreferences: { where: { userId: scope.userId } } },
  });
  if (!credential) return null;
  const { userPreferences, ...row } = credential;
  const preference = userPreferences[0];
  return preference
    ? withModelPreference({ ...preference, credential: row })
    : { ...row, defaultModel: null, thinkingLevel: null };
}
