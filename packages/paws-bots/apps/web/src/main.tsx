import "./zod-config";
import "./monitoring-bootstrap";
import { rememberSignupAttribution } from "@rakazo/core/signup-attribution";
import { BotAvatarActivityProvider, Toaster, TooltipProvider } from "@rakazo/ui-web";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router-dom";
import { App } from "./App";
import { DesktopUpdatesProvider } from "./components/DesktopUpdates";
import { I18nBootstrap } from "./components/I18nBootstrap";
import { applyUiDirection } from "./lib/apply-ui-direction";
import { clientUpdates } from "./lib/client-update";
import { webLogoAvatarActivity } from "./lib/logo-avatar-activity";
import { reportCaughtReactError } from "./lib/monitoring";
import { markAfterPaint, markOnce } from "./lib/performance";
import { installPreloadRecovery } from "./lib/preload-recovery";
import { queryClient } from "./lib/query";
import { captureReferral } from "./lib/referral";
import { applyUiAppearance, watchSystemAppearance } from "./lib/ui-appearance";
import { resolveUiLocale } from "./lib/ui-locale";
import { registerServiceWorker } from "./pwa/register";
import { lockStandaloneZoom } from "./pwa/standalone";
import "./styles.css";

markOnce("rk:renderer:module-evaluated");
installPreloadRecovery();
clientUpdates().install();
registerServiceWorker();
lockStandaloneZoom();
applyUiDirection(resolveUiLocale());
applyUiAppearance();
captureReferral(window.location.search);

function PerformanceProbe() {
  useLayoutEffect(() => {
    markOnce("rk:renderer:first-react-commit");
    markAfterPaint("rk:renderer:first-react-painted");
  }, []);
  return null;
}

/** A route change is a safe moment to move onto a newer deployment. */
function ClientUpdateOnNavigate() {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (pathname === previous.current) return;
    previous.current = pathname;
    clientUpdates().navigated();
  }, [pathname]);
  return null;
}

function SignupAttributionOnNavigate() {
  const { pathname, search } = useLocation();
  useLayoutEffect(() => {
    rememberSignupAttribution(window);
  }, [pathname, search]);
  return null;
}

function AppearanceSync() {
  useEffect(() => watchSystemAppearance(), []);
  return null;
}

createRoot(document.getElementById("root")!, { onCaughtError: reportCaughtReactError }).render(
  <StrictMode>
    <PerformanceProbe />
    <AppearanceSync />
    <I18nBootstrap>
      {/* Router state updates must not be transitions: under sustained urgent
          updates (SSE churn while a run streams) a pending navigation is
          preempted indefinitely — useSearchParams/useParams then keep serving
          the stale location, so deep links (?m=) and thread switches never
          land while the URL already moved. */}
      <BrowserRouter useTransitions={false}>
        <SignupAttributionOnNavigate />
        <ClientUpdateOnNavigate />
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
      </BrowserRouter>
    </I18nBootstrap>
  </StrictMode>,
);
