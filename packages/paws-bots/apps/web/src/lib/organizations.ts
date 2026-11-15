import { hostNavigate, localStore } from "../paws/runtime";
import type { OrganizationList } from "@rakazo/contracts";
import { organizationLandingSpaceId, organizationOfSpace } from "@rakazo/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { queryClient, spaceQueries, useQueryUserId } from "./query";
import { ORGANIZATION_SPACES_STORAGE_KEY, rpc, selectedSpaceId, selectSpace } from "./rpc";

export type Organization = OrganizationList["organizations"][number];

/** Organizations belong to the user, not to a Space, so their list is cached once per user. */
export function organizationsQuery(userId: string | null) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "organizations"],
    queryFn: () => rpc.organizations.list(),
  });
}

export function useOrganizations() {
  const userId = useQueryUserId();
  // The pre-app pages (onboarding, plan choice) also read it, so it names its client.
  const { data } = useQuery(
    { ...organizationsQuery(userId), enabled: Boolean(userId) },
    queryClient,
  );
  const organizations = data?.organizations ?? [];
  const spaceId = selectedSpaceId();
  const activeOrganizationId =
    organizationOfSpace(organizations, spaceId)?.id ?? data?.activeOrganizationId ?? null;
  return { organizations, activeOrganizationId };
}

function lastSpaces(): Record<string, string> {
  try {
    const saved = JSON.parse(localStore.getItem(ORGANIZATION_SPACES_STORAGE_KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function rememberSpace(organizationId: string, spaceId: string) {
  try {
    localStore.setItem(
      ORGANIZATION_SPACES_STORAGE_KEY,
      JSON.stringify({ ...lastSpaces(), [organizationId]: spaceId }),
    );
  } catch {
    // Without storage the organization opens at its default Space next time.
  }
}

/** The Space last used in the organization on this device, or its default once that is gone. */
export function landingSpaceId(organization: Organization): string {
  return organizationLandingSpaceId(organization, lastSpaces());
}

/**
 * Called as the selection moves from one Space to another. Crossing into another organization
 * remembers where the user was in the one being left and drops what was cached for its Spaces.
 */
export async function leaveOrganization(
  userId: string | null,
  fromSpaceId: string | null | undefined,
  toSpaceId: string,
): Promise<void> {
  if (!fromSpaceId || fromSpaceId === toSpaceId) return;
  // A link into another organization can arrive before the list has loaded.
  const organizations =
    (await queryClient.ensureQueryData(organizationsQuery(userId)).catch(() => undefined))
      ?.organizations ?? [];
  const from = organizationOfSpace(organizations, fromSpaceId);
  const to = organizationOfSpace(organizations, toSpaceId);
  if (!from || !to || from.id === to.id) return;
  rememberSpace(from.id, fromSpaceId);
  // The departing shell saves its Space's seed as it unmounts, so this runs after it.
  window.setTimeout(() => {
    const current = selectedSpaceId();
    if (current && from.spaceIds.includes(current)) return;
    for (const spaceId of [...from.spaceIds, null]) {
      queryClient.removeQueries({ queryKey: spaceQueries(userId, spaceId).key() });
    }
  }, 0);
}

type OpenSpaceChat = (spaceId: string, path: string) => void;

/**
 * Moves to a Space that may be in another organization: in place inside the shell, by loading the
 * page outside it. False when the Space could not be selected.
 */
export async function openOrganizationSpace(
  userId: string | null,
  spaceId: string,
  path: string,
  openSpaceChat?: OpenSpaceChat,
): Promise<boolean> {
  if (openSpaceChat) {
    openSpaceChat(spaceId, path);
    return true;
  }
  await leaveOrganization(userId, selectedSpaceId(), spaceId);
  if (!selectSpace(spaceId)) return false;
  hostNavigate(path);
  return true;
}

export function switchOrganization(
  userId: string | null,
  target: Organization,
  openSpaceChat?: OpenSpaceChat,
): Promise<boolean> {
  return openOrganizationSpace(
    userId,
    landingSpaceId(target),
    openSpaceChat ? "/app" : "/",
    openSpaceChat,
  );
}
