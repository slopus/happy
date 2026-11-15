import type { AppBootstrap } from "@rakazo/contracts";

export function initialBootstrapTarget(path: string, desktop: boolean) {
  const pathname = path.split(/[?#]/)[0] ?? "";
  const appRoute = pathname === "/app" || pathname.startsWith("/app/");
  if (!appRoute && !(desktop && pathname === "/")) return null;
  return { botId: appRoute ? botIdFromPath(pathname) : undefined };
}

function botIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  if (["g", "artifacts", "board", "x"].includes(segments[2] ?? "")) return undefined;
  const encoded = segments[2];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/**
 * Where to open a linked bot that is the user's but not in the Space just loaded. The link's
 * query (a message to jump to, a routine) comes along.
 */
export function linkedBotRoute(
  bootstrap: Pick<AppBootstrap, "botSpaceId" | "bots" | "me">,
  botId: string | undefined,
  search: string,
): { spaceId: string; path: string } | undefined {
  if (!botId || !bootstrap.botSpaceId || bootstrap.botSpaceId === bootstrap.me.spaceId)
    return undefined;
  if (bootstrap.bots.some((bot) => bot.id === botId)) return undefined;
  return { spaceId: bootstrap.botSpaceId, path: `/app/${encodeURIComponent(botId)}${search}` };
}
