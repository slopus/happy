import "../zod-config";
import { BotAvatarActivityProvider, Toaster, TooltipProvider } from "@rakazo/ui-web";
import { PawsPortalContext } from "@rakazo/ui-web/paws-host";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate, useLocation } from "react-router-dom";
import { App } from "../App";
import { DesktopUpdatesProvider } from "../components/DesktopUpdates";
import { I18nBootstrap } from "../components/I18nBootstrap";
import { webLogoAvatarActivity } from "../lib/logo-avatar-activity";
import { queryClient } from "../lib/query";
import { disposeCallSession } from "../lib/call-session";
import { setHostNavigate, localStore } from "./runtime";
import type { HostOptions } from "./runtime";
import "../styles.css";

function HostNavigation({ ready }: { ready(): void }) {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => { try { localStore.setItem("paws:last-route", location.pathname + location.search); } catch {} }, [location]);
  useEffect(() => { setHostNavigate(path => navigate(path)); ready(); }, [navigate, ready]);
  return null;
}
export function renderEmbedded(element: HTMLElement, options: HostOptions) {
  const root = createRoot(element, { onUncaughtError: () => options.onFailure() });
  let initial = "/app";
  try { const saved = localStore.getItem("paws:last-route"); if (saved && /^\/app(?:[/?]|$)/.test(saved)) initial = saved; } catch {}
  root.render(
    <PawsPortalContext.Provider value={element}>
      <I18nBootstrap>
        <MemoryRouter initialEntries={[initial]}>
          <HostNavigation ready={options.onAuthenticated} />
          <QueryClientProvider client={queryClient}>
            <DesktopUpdatesProvider>
              <TooltipProvider>
                <BotAvatarActivityProvider source={webLogoAvatarActivity}>
                  <App />
                </BotAvatarActivityProvider>
              </TooltipProvider>
              <Toaster />
            </DesktopUpdatesProvider>
          </QueryClientProvider>
        </MemoryRouter>
      </I18nBootstrap>
    </PawsPortalContext.Provider>,
  );
  return () => { disposeCallSession(); root.unmount(); void queryClient.cancelQueries(); queryClient.clear(); };
}
