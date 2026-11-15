import type { AnalyticsScreen } from "@rakazo/contracts";

/** Convert navigation to a fixed vocabulary; never return paths, entity ids or search parameters. */
export function analyticsScreen(pathname: string): AnalyticsScreen | undefined {
  if (pathname === "/" || pathname === "/app") return "home";
  if (pathname === "/onboarding") return "onboarding";
  if (
    /^\/app\/artifacts(?:\/[^/]+)?$/.test(pathname) ||
    ["/artifacts", "/artifact", "/image"].includes(pathname)
  )
    return "artifacts";
  if (pathname === "/app/board") return "board";
  if (/^\/app\/(?:g\/)?[^/]+$/.test(pathname) || ["/thread", "/group-thread"].includes(pathname))
    return "chat";
  if (pathname === "/computer") return "computer";
  if (pathname === "/search") return "search";
  if (pathname === "/new") return "new_bot";
  if (pathname === "/bot-profile") return "bot_profile";
  if (pathname === "/routine") return "routine";
  if (["/integrations/setup", "/integrations", "/integration-setup"].includes(pathname))
    return "integrations";
  if (
    [
      "/voice",
      "/language",
      "/archived-bots",
      "/ai-data-sharing",
      "/change-password",
      "/account",
      "/models",
      "/bot-settings",
      "/group-settings",
      "/new-space",
      "/new-group",
    ].includes(pathname)
  )
    return "settings";
  return undefined;
}
